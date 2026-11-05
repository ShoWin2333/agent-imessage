import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { DshNativeHost } from '../src/plugin/native.js'
import { registerSharedApprovals } from '../src/plugin/shared-approvals.js'
import { ChannelInteractions } from '../src/plugin/interactions.js'
import type { ChannelMessage } from '../src/channels/types.js'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
const qs=[{id:'pick',question:'Synthetic question',options:[{label:'One'},{label:'Two'}]}]
async function fixture(before?:(ctx:Context)=>void, { input = 'synthetic', channel = 'discord', submit = true, shared = true } = {}) {
  const ctx=new Context(),session=Session.create(SessionId('channels-binding-synthetic'))
  let live:any
  const agent={id:session.id,session,ctx,inbox:{clear:vi.fn(),remove:vi.fn(()=>false)},cancel:vi.fn(),followup:vi.fn((message:any)=>{
    session.append('turn/start',{turn:1});ctx.emit('agent/inbox/claimed',{agent,message,turn:1} as never)
  })}
  live=agent
  const services=await ctx.plugin((ctx:Context)=>{
    ctx.provide('agents',{get:()=>live,roots:()=>[live],create:async()=>({agent,dispose:async()=>{ctx.emit('agent/disposed',{agent} as never);live=undefined}})})
    ctx.provide('sessions',{flush:async()=>true})
    ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'synthetic',model:'never-called'})})
    ctx.provide('agentPresets',{defaultId:'synthetic',mount:async()=>{},serviceFor:()=>undefined})
    ctx.provide('systemPrompt', { tools: () => () => {} })
    ctx.provide('fs', {
      resolve: async (path: string) => ({ displayPath: path }),
      processPath: (target: { displayPath: string }) => target.displayPath,
      contains: () => true,
      stat: async () => ({ type: 'file', size: 4 }),
      readBytes: async () => Buffer.from('test'),
    } as never)
    ctx.provide('permissionPresets',{resolve:()=>{},set:()=>{}})
  })
  const approval=await ctx.plugin(ApprovalService,{policy:'ask'}),questions=await ctx.plugin(UserQuestionService)
  const tools = await ctx.plugin(Tools)
  before?.(ctx)
  // Match the installed plugin: approval is available via get(), but is not
  // a declared injection on the context that constructs DshNativeHost.
  let pluginContext!: Context
  const plugin = await ctx.plugin({
    inject: ['agents', 'sessions', 'agentDefaultModel', 'agentPresets', 'permissionPresets'],
    apply(context: Context) { pluginContext = context },
  })
  const native=await new DshNativeHost(pluginContext,'/tmp','workspace-write','binding',undefined,undefined,channel).open()
  const broker=new ChannelInteractions(()=>true),send=vi.fn(async(_text:string)=>{}),message={send} as unknown as ChannelMessage
  const handlers={approval:(request:any)=>broker.approval(request,message),question:(request:any)=>broker.question(request,message)}
  const media = vi.fn(async () => ({ delivery: 'sent' as const, name: 'sample.mp3', bytes: 4, mode: 'voice' as const }))
  const removeApproval = shared ? registerSharedApprovals(pluginContext, ({ agent: requested }) => requested === live && requested === agent,
    (request, settled) => broker.approval(request, message, settled)) : () => {}
  const operation = submit ? native.submit('owned', input, () => {}, handlers, media) : undefined
  await operation?.admitted
  if (!submit) session.append('turn/start', { turn: 1 })
  const executeMedia = (kind: 'voice' | 'file' | 'image') => ctx.tools.get('channel_send_media')!.execute(
    { kind, path: 'sample.mp3' }, { agent, callId: 'synthetic-call', signal: new AbortController().signal } as never,
  )
  cleanup.push(async()=>{removeApproval();broker.cancel();await native.close();await operation?.result;await plugin.dispose();await tools.dispose();await questions.dispose();await approval.dispose();await services.dispose()})
  const token=()=>send.mock.calls.at(-1)![0].match(/\/(?:approve|answer) ([A-Za-z0-9_-]+)/)![1]!
  const ready=async()=>{await vi.waitFor(()=>expect(send).toHaveBeenCalled());await Promise.resolve();await Promise.resolve()}
  return {ctx,agent,session,native,broker,send,message,token,ready,media,executeMedia,unregister:removeApproval,replace:()=>{live={...agent}}}
}
it('runs outer and downstream middleware once without mutating a frozen native request', async () => {
  const outer = vi.fn(), inner = vi.fn()
  const f = await fixture(ctx => {
    ctx.on('approval/request', async (_request, next) => { inner(); return next() })
    ctx.on('approval/request', async () => 'rejected')
  })
  f.ctx.on('approval/request', async (_request, next) => { outer(); return next() }, { prepend: true })
  const controller = new AbortController()
  const request = Object.freeze({ agent:f.agent as never, toolName:'write', reason:'Synthetic action', signal:controller.signal })
  expect(await f.ctx.approval.request(request)).toBe('rejected')
  expect(outer).toHaveBeenCalledOnce()
  expect(inner).toHaveBeenCalledOnce()
  expect(request.signal).toBe(controller.signal)
  expect(controller.signal.aborted).toBe(false)
})

it('preserves the original Cordis dispatch snapshot when downstream handlers change during an outer await', async () => {
  const old=vi.fn(async():Promise<ApprovalOutcome>=>'rejected')
  const replacement=vi.fn(async():Promise<ApprovalOutcome>=>'allowed-once')
  let remove!:()=>boolean
  const f=await fixture(ctx=>{remove=ctx.on('approval/request',old)})
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  f.ctx.on('approval/request',async(_request,next)=>{entered.resolve();await release.promise;return next()},{prepend:true})
  const result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})
  await entered.promise
  remove();f.ctx.on('approval/request',replacement)
  release.resolve()
  expect(await result).toBe('rejected')
  expect(old).toHaveBeenCalledOnce()
  expect(replacement).not.toHaveBeenCalled()
})

it.each(['expired', 'delivery-failed'] as const)('keeps desktop approval open beyond two minutes after the channel is %s', async failure => {
  const desktop = Promise.withResolvers<ApprovalOutcome>()
  const showDesktop = vi.fn((_request: { signal?: AbortSignal }) => desktop.promise)
  const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) })
  const closeCard = vi.fn(async () => {})
  f.message.sendApproval = vi.fn(async () => closeCard)
  if (failure === 'delivery-failed') vi.mocked(f.message.sendApproval).mockRejectedValueOnce(new Error('offline'))
  vi.useFakeTimers()
  try {
    let finished = false
    const controller=new AbortController()
    const result = f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action',signal:controller.signal}).then(value => {finished=true;return value})
    await vi.advanceTimersByTimeAsync(120001)
    expect(finished).toBe(false)
    expect(showDesktop.mock.calls[0]![0].signal?.aborted).toBe(false)
    if (failure === 'expired') {
      expect(closeCard).toHaveBeenCalledExactlyOnceWith('expired')
      const token=vi.mocked(f.message.sendApproval).mock.calls[0]![1]
      expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效')
    }
    desktop.resolve('allowed-once')
    expect(await result).toBe('allowed-once')
    expect(showDesktop.mock.calls[0]![0].signal?.aborted).toBe(false)
  } finally { vi.useRealTimers() }
})

it('shows the actual desktop rejection when a simultaneous channel grant loses', async () => {
  const desktop = Promise.withResolvers<ApprovalOutcome>()
  const f = await fixture(ctx => { ctx.on('approval/request', () => desktop.promise) })
  const closeCard = vi.fn(async () => {})
  f.message.sendApproval = vi.fn(async () => closeCard)
  const result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})
  await vi.waitFor(()=>expect(f.message.sendApproval).toHaveBeenCalledOnce())
  await Promise.resolve();await Promise.resolve()
  const token=vi.mocked(f.message.sendApproval).mock.calls[0]![1]
  desktop.resolve('rejected')
  f.broker.reply(`/approve ${token}`)
  expect(await result).toBe('rejected')
  expect(closeCard).toHaveBeenCalledExactlyOnceWith('rejected')
  expect(f.session.snapshotEvents().filter(e=>e.type==='approval/decided').map(e=>e.data.outcome)).toEqual(['rejected'])
})

it.each(['turn-end','unload','abort'] as const)('ends shared coordination on %s while preserving the native desktop signal', async action => {
  const desktop = vi.fn((request: {signal?:AbortSignal}) => new Promise<ApprovalOutcome>(resolve=>{
    request.signal?.addEventListener('abort',()=>resolve('cancelled'),{once:true})
  }))
  const f=await fixture(ctx=>{ctx.on('approval/request',desktop)})
  const controller=new AbortController()
  const result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action',signal:controller.signal})
  await f.ready()
  if(action==='turn-end') {
    f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
    f.ctx.emit('session/event',f.session,f.session.snapshotEvents().at(-1)!)
  } else if(action==='unload') f.unregister()
  else controller.abort()
  expect(await result).toBe('cancelled')
  expect(desktop.mock.calls[0]![0].signal).toBe(controller.signal)
  expect(controller.signal.aborted).toBe(action==='abort')
})
it.each([
  ['telegram', 'mobile'], ['telegram', 'desktop'], ['discord', 'mobile'], ['discord', 'desktop'],
] as const)('shares one %s upload approval, answered on %s', async (channel, winner) => {
  const desktop = Promise.withResolvers<ApprovalOutcome>()
  const showDesktop = vi.fn((_request: { signal?: AbortSignal }) => desktop.promise)
  const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) }, { input: '请给我发一段语音。', channel, shared: true })
  const closeCard = vi.fn(async () => {})
  f.message.sendApproval = vi.fn(async () => closeCard)
  const result = f.executeMedia('voice')
  await vi.waitFor(() => expect(f.message.sendApproval).toHaveBeenCalledOnce())
  expect(showDesktop).toHaveBeenCalledOnce()
  expect(f.media).not.toHaveBeenCalled()
  const [, token] = vi.mocked(f.message.sendApproval).mock.calls[0]!
  const [{ signal }] = showDesktop.mock.calls[0]!
  await Promise.resolve()
  await Promise.resolve()
  if (winner === 'mobile') f.broker.reply(`/approve ${token}`)
  else desktop.resolve('allowed-once')
  await expect(result).resolves.toMatchObject({ delivery: 'sent' })
  expect(signal?.aborted).toBe(false)
  expect(closeCard).toHaveBeenCalledExactlyOnceWith('allowed-once')
  expect(() => f.broker.reply(`/deny ${token}`)).toThrow('失效')
  desktop.resolve('rejected')
  expect(f.media).toHaveBeenCalledOnce()
  const events = f.session.snapshotEvents()
  expect(events.filter(e => e.type === 'approval/asked')).toHaveLength(1)
  expect(events.filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual(['allowed-once'])
})

it.each(['weixin', 'imessage'])('shares a %s text approval with desktop and rejects reuse', async channel => {
  for (const winner of ['mobile', 'desktop']) {
    const desktop = Promise.withResolvers<ApprovalOutcome>()
    const showDesktop = vi.fn(() => desktop.promise)
    const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) }, { channel, submit: winner === 'desktop', shared: true })
    const result = f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Write synthetic file' })
    await f.ready()
    expect(showDesktop).toHaveBeenCalledOnce()
    const code = f.token()
    expect(code).toMatch(/^[A-Za-z0-9_-]{8}$/)
    expect(f.send.mock.calls[0]?.[0]).toContain('也可在 DSH 桌面处理')
    const expected = winner === 'mobile' ? 'rejected' : 'allowed-once'
    if (winner === 'mobile') f.broker.reply(`/deny ${code}`)
    else desktop.resolve('allowed-once')
    expect(await result).toBe(expected)
    expect(() => f.broker.reply(`/approve ${code}`)).toThrow('失效')
    desktop.resolve('allowed-once')
    const events = f.session.snapshotEvents()
    expect(events.filter(e => e.type === 'approval/asked')).toHaveLength(1)
    expect(events.filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual([expected])
  }
})

it('shows a desktop-started approval in Telegram even before any channel input is submitted', async () => {
  const desktop = Promise.withResolvers<ApprovalOutcome>()
  const showDesktop = vi.fn(() => desktop.promise)
  const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) }, { channel: 'telegram', submit: false })
  const ask = () => f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Write synthetic file' })
  const result = ask()
  await f.ready()
  expect(showDesktop).toHaveBeenCalledOnce()
  f.broker.reply(`/deny ${f.token()}`)
  expect(await result).toBe('rejected')
  desktop.resolve('allowed-once')
  expect(f.session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)).toEqual(['rejected'])
})

it('keeps the desktop answer available if Telegram delivery fails', async () => {
  const desktop = Promise.withResolvers<ApprovalOutcome>()
  const f = await fixture(ctx => { ctx.on('approval/request', () => desktop.promise) }, { channel: 'telegram' })
  f.send.mockRejectedValueOnce(new Error('Telegram offline'))
  const result = f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Write synthetic file' })
  await f.ready()
  desktop.resolve('allowed-once')
  expect(await result).toBe('allowed-once')
})

it('invalidates channel replies when the DSH session changes to never', async () => {
  const showDesktop = vi.fn((request: { signal?: AbortSignal }) => new Promise<ApprovalOutcome>(resolve => {
    request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))
  const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) }, { channel: 'telegram' })
  const result = f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Write synthetic file' })
  await f.ready()
  const token = f.token()
  setApprovalPolicy(f.session, 'never')
  f.ctx.emit('session/event', f.session, f.session.snapshotEvents().at(-1)!)
  expect(await result).toBe('cancelled')
  expect(showDesktop.mock.calls[0]?.[0].signal).toBeUndefined()
  expect(() => f.broker.reply(`/approve ${token}`)).toThrow('失效')
})

it('never auto-approves a voice request under the shared DSH policy', async () => {
  const showDesktop = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
  const f = await fixture(ctx => { ctx.on('approval/request', showDesktop) }, { input: '发语音', channel: 'telegram' })
  setApprovalPolicy(f.session, 'never')
  await expect(f.executeMedia('voice')).rejects.toThrow('not approved')
  expect(showDesktop).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.media).not.toHaveBeenCalled()
})

it('uses real native approval policy/audit; never bypasses never, then allows exactly once',async()=>{
  const f=await fixture()
  setApprovalPolicy(f.session,'never')
  expect(await f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Write synthetic file'})).toBe('rejected')
  expect(f.send).not.toHaveBeenCalled()
  setApprovalPolicy(f.session,'ask')
  const result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Write synthetic file'})
  await f.ready();f.broker.reply(`/approve ${f.token()}`)
  expect(await result).toBe('allowed-once')
  const events=f.session.snapshotEvents()
  expect(events.filter(e=>e.type==='approval/asked')).toHaveLength(2)
  expect(events.filter(e=>e.type==='approval/decided').map(e=>e.data.outcome)).toEqual(['rejected','allowed-once'])
  expect(events.filter(e=>e.type==='approval/policy')).toHaveLength(2)
})
it.each(['before', 'after'] as const)('shares Discord approvals with desktop registered %s the coordinator', async order => {
  const desktop = vi.fn(async (): Promise<ApprovalOutcome> => 'allowed-once')
  const register = (ctx: Context) => { ctx.on('approval/request', desktop) }
  const f = await fixture(order === 'before' ? register : undefined, { channel: 'discord' })
  if (order === 'after') register(f.ctx)
  expect(await f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Synthetic action' })).toBe('allowed-once')
  expect(desktop).toHaveBeenCalledOnce()
})

it('fails closed when neither desktop nor channel can answer', async () => {
  const f = await fixture(ctx => { ctx.on('approval/request', async () => 'unavailable') })
  f.send.mockRejectedValueOnce(new Error('Synthetic send failure'))
  expect(await f.ctx.approval.request({ agent: f.agent as never, toolName: 'write', reason: 'Synthetic action' })).toBe('unavailable')
})

it.each(['before','after'] as const)('preserves host question answer registered %s channel handler',async order=>{
  const answer={answers:[{id:'pick',selected:['Two']}]}
  const host=(ctx:Context)=>{ctx.on('user-questions/request',async()=>answer)}
  const f=await fixture(order==='before'?host:undefined);if(order==='after')host(f.ctx)
  expect(await f.ctx.userQuestions.ask({agent:f.agent as never,questions:qs})).toEqual(answer)
  expect(f.send).not.toHaveBeenCalled()
})
it('routes native NO_PROVIDER through channel and preserves typed question answer',async()=>{
  const f=await fixture(),result=f.ctx.userQuestions.ask({agent:f.agent as never,questions:qs})
  await f.ready();f.broker.reply(`/answer ${f.token()} 2`)
  expect(await result).toEqual({answers:[{id:'pick',selected:['Two']}]})
})
it('does not fall back for unrelated native question errors',async()=>{
  const f=await fixture();f.ctx.on('user-questions/request',async()=>{throw new UserQuestionError('host rejected','HOST_REFUSED')})
  await expect(f.ctx.userQuestions.ask({agent:f.agent as never,questions:qs})).rejects.toMatchObject({code:'HOST_REFUSED'})
  expect(f.send).not.toHaveBeenCalled()
})
it('replaced Agent with the same ID cannot consume an old approval capability',async()=>{
  const f=await fixture(),result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})
  await f.ready();const token=f.token();f.replace()
  expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效');expect(await result).toBe('cancelled')
})
it.each(['cancel','turn-end','dispose'] as const)('invalidates no-signal questions on %s',async action=>{
  const f=await fixture(),result=f.ctx.userQuestions.ask({agent:f.agent as never,questions:qs})
  const rejected=expect(result).rejects.toMatchObject({code:'ASK_ABORTED'})
  await f.ready();const token=f.token()
  if(action==='cancel')f.native.cancel()
  if(action==='dispose')await f.native.close()
  if(action==='turn-end') {
    f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
    f.ctx.emit('session/event',f.session,f.session.snapshotEvents().at(-1)!)
  }
  await rejected;expect(()=>f.broker.reply(`/answer ${token} 1`)).toThrow('失效')
})
it('ignores another Agent/session and unclaimed turns',async()=>{
  const f=await fixture(undefined,{shared:false}),other={...f.agent,session:Session.create(SessionId('other'))}
  other.session.append('turn/start',{turn:1})
  expect(await f.ctx.approval.request({agent:other as never,toolName:'write',reason:'Other session'})).toBe('unavailable')
  f.session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  f.session.append('turn/start',{turn:2})
  expect(await f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Unclaimed turn'})).toBe('unavailable')
  expect(f.send).not.toHaveBeenCalled()
})
it('a channel cannot grant after native approval policy changes to never',async()=>{
  const f=await fixture(),result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})
  await f.ready();const token=f.token();setApprovalPolicy(f.session,'never')
  expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效');expect(await result).toBe('cancelled')
})

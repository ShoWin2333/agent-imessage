import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { DshNativeHost } from '../src/plugin/native.js'
import { ChannelInteractions } from '../src/plugin/interactions.js'
import type { ChannelMessage } from '../src/channels/types.js'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
const qs=[{id:'pick',question:'Synthetic question',options:[{label:'One'},{label:'Two'}]}]
async function fixture(before?:(ctx:Context)=>void) {
  const ctx=new Context(),session=Session.create(SessionId('channels-binding-synthetic'))
  let live:any
  const agent={id:session.id,session,inbox:{clear:vi.fn()},cancel:vi.fn(),followup:vi.fn((message:any)=>{
    session.append('turn/start',{turn:1});ctx.emit('agent/inbox/claimed',{agent,message,turn:1} as never)
  })}
  live=agent
  const services=await ctx.plugin((ctx:Context)=>{
    ctx.provide('agents',{get:()=>live,roots:()=>[live],create:async()=>({agent,dispose:async()=>{ctx.emit('agent/disposed',{agent} as never);live=undefined}})})
    ctx.provide('sessions',{flush:async()=>true})
    ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'synthetic',model:'never-called'})})
    ctx.provide('agentPresets',{defaultId:'synthetic',mount:async()=>{}})
    ctx.provide('permissionPresets',{resolve:()=>{},set:()=>{}})
  })
  const approval=await ctx.plugin(ApprovalService,{policy:'ask'}),questions=await ctx.plugin(UserQuestionService)
  before?.(ctx)
  const native=await new DshNativeHost(ctx,'/tmp','workspace-write','binding').open()
  const broker=new ChannelInteractions(()=>true),send=vi.fn(async(_text:string)=>{}),message={send} as unknown as ChannelMessage
  const handlers={approval:(request:any)=>broker.approval(request,message),question:(request:any)=>broker.question(request,message)}
  const operation=native.submit('owned','synthetic',()=>{},handlers);await operation.admitted
  cleanup.push(async()=>{broker.cancel();await native.close();await operation.result;await questions.dispose();await approval.dispose();await services.dispose()})
  const token=()=>send.mock.calls.at(-1)![0].match(/\/(?:approve|answer) ([aq]-[a-f0-9-]+)/)![1]!
  const ready=async()=>{await vi.waitFor(()=>expect(send).toHaveBeenCalled());await Promise.resolve();await Promise.resolve()}
  return {ctx,agent,session,native,broker,send,token,ready,replace:()=>{live={...agent}}}
}
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
it.each(['before','after'] as const)('preserves host approval outcome for handler registered %s channel handler',async order=>{
  const host=(ctx:Context)=>{ctx.on('approval/request',async()=> 'rejected')}
  const f=await fixture(order==='before'?host:undefined);if(order==='after')host(f.ctx)
  expect(await f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})).toBe('rejected')
  expect(f.send).not.toHaveBeenCalled()
})
it.each(['allowed-once','cancelled'] as ApprovalOutcome[])('keeps native host %s without a channel prompt',async outcome=>{
  const f=await fixture(ctx=>{ctx.on('approval/request',async()=>outcome)})
  expect(await f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})).toBe(outcome)
  expect(f.send).not.toHaveBeenCalled()
})
it('host approval failure fails closed and never creates an alternate channel grant',async()=>{
  const f=await fixture();f.ctx.on('approval/request',async()=>{throw new Error('synthetic host failure')})
  expect(await f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})).toBe('unavailable')
  expect(f.send).not.toHaveBeenCalled()
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
it('does not race a pending host approval; rechecks ownership after delegation',async()=>{
  let release!:(v:ApprovalOutcome)=>void
  const f=await fixture();f.ctx.on('approval/request',()=>new Promise(resolve=>{release=resolve}))
  const result=f.ctx.approval.request({agent:f.agent as never,toolName:'write',reason:'Synthetic action'})
  await vi.waitFor(()=>expect(release).toBeDefined());expect(f.send).not.toHaveBeenCalled()
  f.native.cancel();release('unavailable')
  expect(await result).toBe('cancelled');expect(f.send).not.toHaveBeenCalled()
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
  const f=await fixture(),other={...f.agent,session:Session.create(SessionId('other'))}
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

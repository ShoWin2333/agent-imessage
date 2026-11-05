import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Tools from '@deepseek-ai/dsh-tools'
import { DshNativeHost } from '../src/plugin/native.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture({ presetFs = true, agentFs = false, channelKind = 'imessage' } = {}) {
  const ctx = new Context(), agentCtx = new Context(), session = Session.create(SessionId('channels-binding-test'))
  let live: any, decision = 'allowed-once'
  const agent = { id: session.id, session, ctx: agentCtx, inbox: { clear: vi.fn(), remove: vi.fn(() => false) }, cancel: vi.fn(), followup: vi.fn((input: any) => {
    session.append('turn/start', { turn: 1 }); agentCtx.emit('agent/inbox/claimed', { agent, message: input, turn: 1 } as never)
  }) }
  live = agent
  const read = vi.fn(async () => Buffer.from('test'))
  const reader = { resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path.startsWith('/') ? path : `/workspace/${path}` })), processPath: (target: { displayPath: string }) => target.displayPath, contains: () => true, stat: async () => ({ type: 'file', size: 4 }), readBytes: read }
  const agentRead = vi.fn(async () => Buffer.from('test'))
  const agentReader = { ...reader, contains: vi.fn(() => true), readBytes: agentRead }
  const request = vi.fn(async () => decision), flush = vi.fn(async () => true)
  const provide = (scope: Context) => scope.plugin((c: Context) => {
    c.provide('agents', { get: () => live, create: async () => ({ agent, dispose: async () => { agentCtx.emit('agent/disposed', { agent } as never); live = undefined } }) })
    c.provide('sessions', { flush })
    c.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'never-called' }) })
    c.provide('agentPresets', { defaultId: 'synthetic', mount: async () => {}, serviceFor: () => presetFs ? reader : undefined })
    c.provide('permissionPresets', { resolve: () => {}, set: () => {} })
    c.provide('approval', { request })
    if (agentFs && scope === agentCtx) c.provide('fs', agentReader as never)
    c.provide('systemPrompt', { tools: () => () => {} })
  })
  const services = await provide(ctx), agentServices = await provide(agentCtx), tools = await agentCtx.plugin(Tools)
  const native = await new DshNativeHost(ctx, '/workspace', 'workspace-write', 'binding', undefined, undefined, channelKind).open()
  const send = vi.fn(async (): Promise<{ delivery: 'sent'; name: string; bytes: number; mode: 'image' | 'voice' }> => ({ delivery: 'sent', name: 'test.png', bytes: 4, mode: 'image' }))
  const notice=vi.fn(async()=>{});const operation = native.submit('input', 'send image', () => {}, undefined, send,undefined,notice); await operation.admitted
  const definition = agentCtx.tools.get('channel_send_media')!
  const exec = { agent, callId: 'call', signal: new AbortController().signal } as any
  const call = (overrides = {}, args = { path: 'test.png', kind: 'image' }) => definition.execute(args, { ...exec, ...overrides })
  cleanup.push(async () => { await native.close(); await operation.result; await tools.dispose(); await agentServices.dispose(); await services.dispose() })
  return { ctx, agentCtx, agent, session, native, call, send, read, reader, agentRead, agentReader, request, flush, notice, setDecision: (next: string) => { decision = next } }
}
it('registers the capability through real Tools, approves before composed reads, flushes before sending, unregisters on close', async () => {
  const f = await fixture()
  expect(f.agentCtx.tools.get('channel_send_media')).toBeDefined()
  f.request.mockImplementationOnce(async () => { expect(f.read).not.toHaveBeenCalled(); return 'allowed-once' })
  f.send.mockImplementationOnce(async () => { expect(f.flush).toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce(); return { delivery: 'sent', name: 'test.png', bytes: 4, mode: 'image' } })
  expect(await f.call()).toMatchObject({ delivery: 'sent' }); expect(f.send.mock.calls[0]![0]).toMatchObject({ inputId: 'input', sessionId: f.agent.id, turn: 1, kind: 'image' })
  await f.native.close(); expect(f.agentCtx.tools.get('channel_send_media')).toBeUndefined()
})
it('refuses absent grants without reading or uploading and respects composed fs denial', async () => {
  const f = await fixture()
  for (const outcome of ['rejected', 'unavailable', 'cancelled']) { f.setDecision(outcome); await expect(f.call()).rejects.toThrow('not approved') }
  expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  f.setDecision('allowed-once'); f.read.mockRejectedValueOnce(new Error('FS_POLICY_DENIED'))
  await expect(f.call()).rejects.toThrow('FS_POLICY_DENIED'); expect(f.send).not.toHaveBeenCalled()
})
it('uses the Agent-visible DSH filesystem when Desktop supplies it outside the preset', async () => {
  const f = await fixture({ presetFs: false, agentFs: true })
  f.request.mockImplementationOnce(async () => {
    expect(f.agentRead).not.toHaveBeenCalled()
    return 'allowed-once'
  })
  f.agentReader.contains.mockReturnValueOnce(false)
  await expect(f.call()).rejects.toThrow('outside the session workspace')
  expect(f.agentRead).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
  await expect(f.call()).resolves.toMatchObject({ delivery: 'sent' })
  expect(f.agentRead).toHaveBeenCalledOnce()
})

it('does not report a conversion failure for a native Telegram voice that was sent', async () => {
  const f = await fixture({ presetFs: false, agentFs: true, channelKind: 'telegram' })
  f.send.mockResolvedValueOnce({ delivery: 'sent', name: 'sample.mp3', bytes: 4, mode: 'voice' })
  const result = await f.call({}, { path: 'sample.mp3', kind: 'voice' })
  expect(result).toEqual({ delivery: 'sent', name: 'sample.mp3', bytes: 4, mode: 'voice' })
})

it('preserves the isolated preset filesystem and does not retry its denial', async () => {
  const f = await fixture({ agentFs: true })
  f.read.mockRejectedValueOnce(new Error('FS_POLICY_DENIED'))
  await expect(f.call()).rejects.toThrow('FS_POLICY_DENIED')
  expect(f.agentRead).not.toHaveBeenCalled()
  expect(f.send).not.toHaveBeenCalled()
})

it('refuses foreign agent identity, cancelled calls, ended or host-owned turns', async () => {
  const f = await fixture()
  await expect(f.call({ agent: { ...f.agent } })).rejects.toThrow('channel-owned')
  await expect(f.call({ signal: AbortSignal.abort() })).rejects.toThrow()
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); f.session.append('turn/start', { turn: 2 })
  await expect(f.call()).rejects.toThrow('channel-owned'); expect(f.request).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})
it('rechecks current ownership after approval before reading or uploading', async () => {
  const f = await fixture()
  f.request.mockImplementationOnce(async () => { f.native.cancel(); return 'allowed-once' })
  await expect(f.call()).rejects.toThrow('cancelled'); expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
})

it('automatically offers native present files through the existing approval, filesystem and media path', async () => {
  const f=await fixture({channelKind:'qqbot'})
  const exec={agent:f.agent,name:'present',callId:'present-call',signal:new AbortController().signal} as any
  const result={isError:false,value:{turn:1,files:[{path:'report.pdf'}]},content:[]} as any
  const next=vi.fn(async()=>({kind:'accept' as const}))
  await f.agentCtx.waterfall('tools/post-execute',exec,result,next)
  expect(f.request).toHaveBeenCalledOnce();expect(f.send).toHaveBeenCalledOnce()
  expect(f.send.mock.calls[0]![0]).toMatchObject({kind:'file',callId:'present:present-call:0'})
  await f.agentCtx.waterfall('tools/post-execute',exec,result,next)
  expect(f.send).toHaveBeenCalledOnce()
  const rejected={...exec,callId:'blocked-present'}
  await f.agentCtx.waterfall('tools/post-execute',rejected,result,async()=>({kind:'block',feedback:[]}))
  expect(f.request).toHaveBeenCalledOnce()
  f.setDecision('rejected')
  await f.agentCtx.waterfall('tools/post-execute',{...exec,callId:'denied-present'},result,next)
  expect(f.read).toHaveBeenCalledOnce();expect(f.send).toHaveBeenCalledOnce()
  await vi.waitFor(()=>expect(f.notice).toHaveBeenCalledWith(expect.stringContaining('未获批准')))
})

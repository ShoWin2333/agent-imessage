import { expect, it, vi, afterEach } from 'vitest'
import { ChannelBridge, type BindingState, type NativeResult, type NativeSession } from '../src/plugin/bridge.js'
import { resultFromEvents, DshNativeHost } from '../src/plugin/native.js'
import { bindingKey, pluginConfigSchema, apply } from '../src/plugin/index.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const message = (id: string, text = 'synthetic task'): ChannelMessage => ({ id, text, send: vi.fn(async () => { }), responding: async fn => fn(), sendFile: vi.fn(), sendVoice: vi.fn() })
function fixture(initial: BindingState = { receipts: [] }) {
  let state = structuredClone(initial)
  const runs: Array<{ id: string; result: ReturnType<typeof deferred<NativeResult>>; progress: () => void }> = []
  const session: NativeSession = {
id: 'channels-test', submit: vi.fn((id, _text, progress) => {
      const result = deferred<NativeResult>(); runs.push({ id, result, progress }); return { admitted: Promise.resolve(), result: result.promise }
    }), cancel: vi.fn(() => { for (const run of runs) run.result.resolve({ text: 'cancelled', reason: 'interrupted' }) }), close: vi.fn(async () => { })
}
  const host = { open: vi.fn(async () => session), inspect: vi.fn(async () => undefined as NativeResult | undefined) }
  const store = { read: () => state, write: vi.fn(async (value: BindingState) => { state = structuredClone(value) }) }
  return { bridge: new ChannelBridge(host, store), host, store, session, runs }
}
afterEach(() => vi.useRealTimers())
it('durably admits without blocking cancellation; reports progress/result once, deduplicates concurrent/restarted input', async () => {
  const f = fixture(), m = message('1')
  await Promise.all([f.bridge.receive(m), f.bridge.receive(m)])
  expect(f.session.submit).toHaveBeenCalledTimes(1)
  f.runs[0]!.progress(); f.runs[0]!.result.resolve({ text: 'synthetic result', reason: 'completed' })
  await f.bridge.drain()
  expect(m.send).not.toHaveBeenCalledWith('DSH 正在处理…')
  expect(m.send).toHaveBeenCalledWith('synthetic result')
  expect(f.store.read().receipts[0]!.delivery).toBe('sent')
  const restarted = fixture(f.store.read()); await restarted.bridge.receive(m)
  expect(restarted.session.submit).not.toHaveBeenCalled()
  await f.bridge.close(); await restarted.bridge.close()
})
it('waits for native inbox durability before channel admission returns', async () => {
  const f = fixture(), admission = deferred<void>(); let accepted = false
  vi.mocked(f.session.submit).mockImplementation(() => ({ admitted: admission.promise, result: Promise.resolve({ text: 'ok', reason: 'completed' }) }))
  const work = f.bridge.receive(message('1')).then(() => { accepted = true })
  await vi.waitFor(() => expect(f.session.submit).toHaveBeenCalled())
  expect(accepted).toBe(false); admission.resolve(); await work; await f.bridge.drain(); await f.bridge.close()
})
it('cancels immediately even while inbox admission is pending', async () => {
  const f = fixture(), admission = deferred<void>()
  vi.mocked(f.session.submit).mockImplementation(() => ({ admitted: admission.promise, result: Promise.resolve({ text: 'ok', reason: 'completed' }) }))
  const input = f.bridge.receive(message('1')); await vi.waitFor(() => expect(f.session.submit).toHaveBeenCalled())
  const cancel = f.bridge.receive(message('cancel', '/cancel')); expect(f.session.cancel).toHaveBeenCalled()
  admission.resolve(); await input; await cancel; await f.bridge.drain(); await f.bridge.close()
})
it('keeps cancellation independent from a hung outbound send and quarantines ambiguous delivery', async () => {
  const f = fixture(), m = message('1'), send = deferred<void>()
  vi.mocked(m.send).mockImplementation(() => send.promise)
  await f.bridge.receive(m); f.runs[0]!.result.resolve({ text: 'result', reason: 'completed' })
  await vi.waitFor(() => expect(m.send).toHaveBeenCalled())
  const cancel = f.bridge.receive(message('cancel', '/cancel'))
  expect(f.session.cancel).toHaveBeenCalled(); await cancel
  send.resolve(); await f.bridge.drain(); await f.bridge.close()
})
it('recovers durable results, quarantines in-flight sends, never executes/retries uncertain work', async () => {
  const f = fixture({
sessionId: 'channels-test', receipts: [
      { id: 'pending', inputId: 'a', sessionId: 'channels-test', delivery: 'pending' },
      { id: 'sending', inputId: 'b', sessionId: 'channels-test', delivery: 'sending', result: { text: 'do not repeat', reason: 'completed' } },
      { id: 'uncertain', inputId: 'c', sessionId: 'channels-test', delivery: 'uncertain' },
    ]
})
  f.host.inspect.mockResolvedValue({ text: 'persisted synthetic result', reason: 'completed' })
  const delivered: ChannelMessage[] = []
  await f.bridge.recover(async id => { const m = message(id); delivered.push(m); return m })
  expect(delivered).toHaveLength(1); expect(delivered[0]!.send).toHaveBeenCalledWith('persisted synthetic result')
  expect(f.store.read().receipts.find(r => r.id === 'sending')!.delivery).toBe('uncertain')
  expect(f.host.open).not.toHaveBeenCalled(); expect(f.session.submit).not.toHaveBeenCalled()
  await f.bridge.close()
})
it('prunes settled receipts while retaining unsettled and recent ones', async () => {
  const sent = Array.from({ length: 600 }, (_, index) => ({ id: `sent-${index}`, inputId: `input-${index}`, sessionId: 'channels-test', delivery: 'sent' as const, result: { text: 'settled', reason: 'completed' } }))
  const f = fixture({ receipts: [...sent, { id: 'pending-one', inputId: 'pending', sessionId: 'channels-test', delivery: 'pending' }] })
  await f.bridge.receive(message('new'))
  f.runs[0]!.result.resolve({ text: 'ok', reason: 'completed' })
  await f.bridge.drain(); await f.bridge.close()
  const receipts = f.store.read().receipts
  expect(receipts.some(receipt => receipt.id === 'pending-one')).toBe(true)
  expect(receipts.some(receipt => receipt.id === 'sent-0')).toBe(false)
  expect(receipts.some(receipt => receipt.id === 'sent-599')).toBe(true)
  expect(receipts.filter(receipt => receipt.delivery === 'sent').length).toBeLessThanOrEqual(512)
})
it('failed provider send is uncertain and not retried on restart', async () => {
  const f = fixture(), m = message('1'); vi.mocked(m.send).mockRejectedValue(new Error('synthetic transport failure'))
  await f.bridge.receive(m); f.runs[0]!.result.resolve({ text: 'result', reason: 'completed' }); await f.bridge.drain()
  expect(f.store.read().receipts[0]!.delivery).toBe('uncertain')
  const next = fixture(f.store.read()), delivery = vi.fn(); await next.bridge.recover(delivery)
  expect(delivery).not.toHaveBeenCalled(); await f.bridge.close(); await next.bridge.close()
})
const event = (type: string, data: unknown) => ({ type, data }) as SessionEvent
it('reconstructs the exact claimed turn even when pre-step rejected before user/message', () => {
  const events = [event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'owned' }, { id: 'other' }] }),
  event('turn/start', { turn: 1 }), event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
  event('turn/end', { turn: 1, reason: { kind: 'rejected' } }), event('turn/start', { turn: 2 }), event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'private other answer' }] } })]
  expect(resultFromEvents(events, 'owned')).toEqual({ text: '', reason: 'rejected' })
  expect(resultFromEvents(events, 'unknown')).toBeUndefined()
})
it('keeps thought/tool payloads out of replies and isolates another turn', () => {
  const events = [event('turn/start', { turn: 1 }), event('user/message', { id: 'owned' }),
  event('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'other' }] } }),
  event('assistant/message', { turn: 1, message: { content: [{ type: 'reasoning', text: 'private thought' }, { type: 'text', text: 'answer' }] } }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
  expect(resultFromEvents(events, 'owned')).toEqual({ text: 'answer', reason: 'completed' })
})
const binding = { id: 'tg', enabled:true, cwd: '/tmp', channel: { id: 'tg', kind: 'telegram', botId: '123', ownerUserId: '456' }, credentialRef: 'SYNTHETIC_TOKEN', permissionPreset: 'workspace-write' }
it('validates all four channels, owner/scope/permission changes cannot inherit session state', () => {
  const b = pluginConfigSchema.parse({ bindings: [binding] }).bindings[0]!
  for (const change of [{ cwd: '/other' }, { permissionPreset: 'read-only' }, { channel: { ...b.channel, ownerUserId: '789' } }]) expect(bindingKey({ ...b, ...change } as typeof b)).not.toBe(bindingKey(b))
  expect(pluginConfigSchema.safeParse({ bindings: [binding, { ...binding, id: 'two' }] }).success).toBe(false)
  expect(pluginConfigSchema.safeParse({ bindings: [{ ...binding, channel: { ...binding.channel, ownerUserId: '@unknown' } }] }).success).toBe(false)
  for (const channel of [
    { id: 'i', kind: 'imessage', projectId: 'synthetic', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' },
    { id: 'w', kind: 'weixin', accountId: 'bot@synthetic' },
    { id: 'd', kind: 'discord', botId: '123456789012345678', ownerUserId: '234567890123456789' }, binding.channel,
  ]) expect(pluginConfigSchema.safeParse({ bindings: [{ ...binding, channel, weixin: { ownerUserId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com' } }] }).success).toBe(true)
})
it('empty plugin composition is inert; no credential reads or network connections', async () => {
  let stop!: () => Promise<void>; const close = vi.fn(async () => { }), resolve = vi.fn()
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }
  const ctx = { logger: () => logger, plugin: vi.fn(), get: () => undefined, on: vi.fn(), storageDomain: { open: vi.fn(async () => ({ close })) }, effect: (fn: () => () => Promise<void>) => { stop = fn() }, credentials: { resolve } } as unknown as Context
  await apply(ctx, {}); expect(resolve).not.toHaveBeenCalled(); await stop(); expect(close).toHaveBeenCalled()
})
it('native ownership rejects another consumer and cross-workspace sessions', async () => {
  const ctx = { agents: { get: vi.fn(() => ({ id: 'occupied' })) } } as unknown as Context
  const host = new DshNativeHost(ctx, '/tmp', 'workspace-write', 'binding')
  await expect(host.open('occupied')).rejects.toThrow('already owned')
})
it('replayed old cancel cannot cancel a new task', async () => {
  const f = fixture(); await f.bridge.receive(message('cancel', '/cancel'))
  await f.bridge.receive(message('new'))
  vi.mocked(f.session.cancel).mockClear()
  await f.bridge.receive(message('cancel', '/cancel'))
  expect(f.session.cancel).not.toHaveBeenCalled()
  f.runs[0]!.result.resolve({ text: 'ok', reason: 'completed' }); await f.bridge.drain(); await f.bridge.close()
})
it('cancel during session creation fences prompts waiting for admission', async () => {
  const f = fixture(), opened = deferred<NativeSession>(); f.host.open.mockReturnValue(opened.promise)
  const first = f.bridge.receive(message('first')), queued = f.bridge.receive(message('queued'))
  await vi.waitFor(() => expect(f.host.open).toHaveBeenCalled())
  const cancel = f.bridge.receive(message('cancel', '/cancel'))
  opened.resolve(f.session); await Promise.all([first, queued, cancel]); await f.bridge.drain()
  expect(f.session.submit).not.toHaveBeenCalled()
  await f.bridge.close()
})
it('shutdown aborts a hung reply without delaying native cancellation', async () => {
  const f = fixture(), m = message('1'); vi.mocked(m.send).mockReturnValue(new Promise(() => { }))
  await f.bridge.receive(m); f.runs[0]!.result.resolve({ text: 'result', reason: 'completed' })
  await vi.waitFor(() => expect(m.send).toHaveBeenCalled())
  await f.bridge.close()
  expect(f.session.cancel).toHaveBeenCalled(); expect(f.store.read().receipts[0]!.delivery).toBe('uncertain')
})
it('shutdown drains blocked recovery and fences all later writes and sends', async () => {
  const f = fixture({ receipts: [{ id: 'pending', inputId: 'a', sessionId: 'channels-test', delivery: 'pending' }] }), inspect = deferred<NativeResult | undefined>()
  f.host.inspect.mockReturnValue(inspect.promise)
  const delivery = vi.fn(async () => message('pending')), recovery = f.bridge.recover(delivery)
  const close = f.bridge.close(); let finished = false; void close.then(() => { finished = true })
  await Promise.resolve(); expect(finished).toBe(false)
  inspect.resolve({ text: 'must not send after stop', reason: 'completed' })
  await recovery; await close
  expect(delivery).not.toHaveBeenCalled(); expect(f.store.write).not.toHaveBeenCalled()
})
it('unload while credential resolution is pending cannot start a late channel', async () => {
  const credential = deferred<{ value: string; source: string } | undefined>()
  const resolveCredential = vi.fn(() => credential.promise)
  let stop!: () => Promise<void>, closed = false
  const records = new Map<string, unknown>()
  const put = vi.fn(async (key: string, value: unknown) => { if (closed) throw new Error('write after close'); records.set(key, value) })
  const ctx = {
logger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }), plugin: vi.fn(), get: () => undefined, on: vi.fn(),
permissionPresets: { resolve: () => { } }, storageDomain: { open: async () => ({ table: () => ({ get: (key: string) => records.get(key), put }), close: async () => { closed = true } }) },
    credentials: { resolve: resolveCredential }, effect: (fn: () => () => Promise<void>) => { stop = fn() },
  } as unknown as Context
  const applying = apply(ctx, { bindings: [{...binding,cwd:process.cwd()} as any] })
  await vi.waitFor(() => expect(resolveCredential).toHaveBeenCalledTimes(1))
  await stop(); credential.resolve({ value: 'synthetic', source: 'test' })
  await expect(applying).resolves.toBeUndefined()
  expect(closed).toBe(true); expect(put).toHaveBeenCalledTimes(1)
})
it('interaction commands use durable admission, never become model prompts and cannot replay a grant',async()=>{
  const f=fixture(),task=message('task')
  let handlers:import('../src/plugin/interaction-types.js').InteractionHandlers|undefined
  const original=vi.mocked(f.session.submit).getMockImplementation()!
  vi.mocked(f.session.submit).mockImplementation((id,text,progress,interactions)=>{handlers=interactions;return original(id,text,progress,interactions)})
  await f.bridge.receive(task)
  const signal=new AbortController().signal
  const outcome=handlers!.approval({sessionId:f.session.id,inputId:f.runs[0]!.id,turn:1,signal,current:()=>true,toolName:'write_file',reason:'Write synthetic file'})
  await vi.waitFor(()=>expect(task.send).toHaveBeenCalled());await Promise.resolve();await Promise.resolve()
  const prompt=vi.mocked(task.send).mock.calls[0]![0],token=prompt.match(/\/approve (a-[a-f0-9-]+)/)![1]!
  const approve=message('approval',`/approve ${token}`)
  await Promise.all([f.bridge.receive(approve),f.bridge.receive(approve)])
  expect(await outcome).toBe('allowed-once');expect(f.session.submit).toHaveBeenCalledTimes(1)
  expect(f.store.read().receipts.find(r=>r.id==='approval')?.delivery).toBe('sent')
  const invalid=message('late',`/approve ${token}`);await f.bridge.receive(invalid)
  expect(invalid.send).toHaveBeenCalledWith(expect.stringContaining('失效'))
  f.runs[0]!.result.resolve({text:'done',reason:'completed'});await f.bridge.drain();await f.bridge.close()
  const restarted=fixture(f.store.read()),stale=message('after-restart',`/approve ${token}`)
  await restarted.bridge.receive(stale);expect(restarted.host.open).not.toHaveBeenCalled();expect(stale.send).toHaveBeenCalledWith(expect.stringContaining('失效'))
  await restarted.bridge.close()
})
it('failed interaction command persistence cannot resolve the native approval',async()=>{
  const f=fixture(),task=message('task');let handlers:import('../src/plugin/interaction-types.js').InteractionHandlers|undefined
  const original=vi.mocked(f.session.submit).getMockImplementation()!
  vi.mocked(f.session.submit).mockImplementation((id,text,progress,interactions)=>{handlers=interactions;return original(id,text,progress,interactions)})
  await f.bridge.receive(task)
  const outcome=handlers!.approval({sessionId:f.session.id,inputId:f.runs[0]!.id,turn:1,signal:new AbortController().signal,current:()=>true,toolName:'write_file',reason:'Write synthetic file'})
  await vi.waitFor(()=>expect(task.send).toHaveBeenCalled());await Promise.resolve();await Promise.resolve()
  const token=vi.mocked(task.send).mock.calls[0]![0].match(/\/approve (a-[a-f0-9-]+)/)![1]!
  f.store.write.mockRejectedValueOnce(new Error('synthetic persistence failure'))
  await expect(f.bridge.receive(message('approval',`/approve ${token}`))).rejects.toThrow('persistence')
  f.bridge.setConnected(false);expect(await outcome).toBe('cancelled')
  f.runs[0]!.result.resolve({text:'cancelled',reason:'interrupted'});await f.bridge.drain();await f.bridge.close()
})
it('does not send fixed progress or a second reply for an admitted same-turn steering input',async()=>{
 const f=fixture(),a=message('a'),b=message('b');await f.bridge.receive(a);await f.bridge.receive(b)
 f.runs[0]!.progress();f.runs[1]!.progress();f.runs[0]!.result.resolve({text:'combined answer',reason:'completed'});f.runs[1]!.result.resolve({text:'',reason:'completed',suppressed:true});await f.bridge.drain()
 expect(a.send).toHaveBeenCalledExactlyOnceWith('combined answer');expect(b.send).not.toHaveBeenCalled();expect(f.store.read().receipts.every(r=>r.delivery==='sent')).toBe(true)
 const restart=fixture(f.store.read());await restart.bridge.recover(async id=>id==='a'?a:b);expect(b.send).not.toHaveBeenCalled();await f.bridge.close();await restart.bridge.close()
})

import { expect, it, vi } from 'vitest'
import { ChannelBridge, type BindingState, type NativeResult, type NativeSession } from '../src/plugin/bridge.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { MediaHandler, MediaInteraction } from '../src/plugin/media-delivery.js'

async function fixture(initial?: BindingState) {
  let state: BindingState = initial ?? { receipts: [] }
  let media!: MediaHandler, finish!: (result: NativeResult) => void, inputId = ''
  const session: NativeSession = { id: 'session', submit: vi.fn((id, _text, _progress, _interactions, send) => {
    inputId = id; media = send!
    return { admitted: Promise.resolve(), result: new Promise(resolve => { finish = resolve }) }
  }), cancel: vi.fn(), close: vi.fn(async () => { finish?.({ text: 'done', reason: 'completed' }) }) }
  const host = { open: async () => session, inspect: vi.fn(async () => ({ text: 'recovered', reason: 'interrupted' })) }
  const store = { read: () => state, write: vi.fn(async (value: BindingState) => { state = structuredClone(value) }) }
  const message: ChannelMessage = { id: 'external', text: 'send file', nativeVoice: false, responding: fn => fn(), send: vi.fn(async () => {}), sendFile: vi.fn(async () => {}), sendImage: vi.fn(async () => {}), sendVoice: vi.fn(async () => {}) }
  const bridge = new ChannelBridge(host, store)
  await bridge.receive(message)
  const request = (kind: MediaInteraction['kind'] = 'file', callId = 'call'): MediaInteraction => ({ sessionId: 'session', inputId, turn: 1, current: () => true, signal: new AbortController().signal, kind, callId, media: { name: 'test.png', mimeType: 'image/png', bytes: Buffer.from('bounded') } })
  return { bridge, store, message, session, send: (r = request()) => media(r), request, finish }
}
it('commits media sending before upload, records success, dedupes same tool call and preserves receipt during final text delivery', async () => {
  const f = await fixture()
  vi.mocked(f.message.sendFile).mockImplementation(async () => { expect(f.store.read().receipts[0]!.media![0]!.delivery).toBe('sending') })
  expect((await f.send()).delivery).toBe('sent'); expect((await f.send()).delivery).toBe('sent')
  expect(f.message.sendFile).toHaveBeenCalledTimes(1)
  f.finish({ text: 'done', reason: 'completed' }); await f.bridge.drain()
  expect(f.store.read().receipts[0]!.media![0]!.delivery).toBe('sent')
  await f.bridge.close()
})
it('routes images separately and falls back voice to file without first trying native voice', async () => {
  const f = await fixture()
  expect((await f.send(f.request('image', 'image'))).mode).toBe('image')
  expect((await f.send(f.request('voice', 'voice'))).mode).toBe('file')
  expect(f.message.sendImage).toHaveBeenCalledTimes(1); expect(f.message.sendFile).toHaveBeenCalledTimes(1); expect(f.message.sendVoice).not.toHaveBeenCalled()
  await f.bridge.close()
})
it('uses native voice only for native-capable channel', async () => {
  const f = await fixture(); f.message.nativeVoice = true
  expect((await f.send(f.request('voice'))).mode).toBe('voice'); expect(f.message.sendVoice).toHaveBeenCalledOnce()
  await f.bridge.close()
})
it('refuses disconnected, stale, aborted, cross-session or wrong-input capabilities', async () => {
  const f = await fixture()
  for (const change of [{ current: () => false }, { inputId: 'other' }, { sessionId: 'other' }, { signal: AbortSignal.abort() }]) {
    await expect(f.send({ ...f.request(), ...change })).rejects.toThrow()
  }
  f.bridge.setConnected(false); await expect(f.send()).rejects.toThrow()
  expect(f.message.sendFile).not.toHaveBeenCalled(); await f.bridge.close()
})
it('quarantines ambiguous sends and repeated call IDs without retry; recovery never uploads media', async () => {
  const f = await fixture(); vi.mocked(f.message.sendFile).mockRejectedValue(new Error('timeout'))
  expect((await f.send()).delivery).toBe('uncertain'); expect((await f.send()).delivery).toBe('uncertain')
  expect(f.message.sendFile).toHaveBeenCalledOnce()
  f.finish({ text: 'done', reason: 'completed' }); await f.bridge.drain()
  const state = structuredClone(f.store.read()); state.receipts[0]!.media![0]!.delivery = 'sending'
  await f.bridge.close()
  let saved = state
  const recovered = new ChannelBridge({ open: vi.fn(), inspect: vi.fn() }, { read: () => saved, write: async value => { saved = value } })
  const getMessage = vi.fn(); await recovered.recover(getMessage)
  expect(saved.receipts[0]!.media![0]!.delivery).toBe('uncertain'); expect(getMessage).not.toHaveBeenCalled()
  await recovered.close()
})
it('does not upload if the durable media receipt cannot be committed', async () => {
  const f = await fixture(); f.store.write.mockRejectedValueOnce(new Error('disk full'))
  await expect(f.send()).rejects.toThrow('disk full'); expect(f.message.sendFile).not.toHaveBeenCalled()
  await f.bridge.close()
})

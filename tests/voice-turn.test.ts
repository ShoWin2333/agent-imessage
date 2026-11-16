import {it,expect,vi} from 'vitest'
import {ChannelBridge} from '../src/plugin/bridge.js'
import {createVoiceCoach,type VoiceCoach} from '../src/plugin/voice/index.js'
import type {VoiceSettings} from '../src/plugin/voice/types.js'

const replyAudio = Buffer.from('494433040000fffb9000', 'hex')

/**
 * The repo harness blocks real fetch in every test, so the audio model is
 * exercised through a stub that stands in for the chat-completions endpoint.
 */
const speechFetch = (options: { status?: number; audio?: boolean } = {}) => vi.fn(async (input: string | URL | Request) => {
  const url = String(input)
  if (!url.endsWith('/chat/completions')) return new Response('{}', {status: 404})
  if ((options.status ?? 200) !== 200) {
    return new Response(JSON.stringify({error:{message:'The model does not support audio output'}}), {status: options.status, headers:{'content-type':'application/json'}})
  }
  const message: Record<string, unknown> = { audio: { transcript: 'That was close. Try "think", not "sink".' } }
  if (options.audio !== false) message.audio = { data: replyAudio.toString('base64'), transcript: 'That was close. Try "think", not "sink".' }
  return new Response(JSON.stringify({choices:[{message}]}), {status: 200, headers:{'content-type':'application/json'}})
})

const settings = (patch: Partial<VoiceSettings> = {}): VoiceSettings => ({
  enabled: true, credentialRef: 'CHANNELS_OPENAI_API_KEY', baseURL: 'https://api.openai.test/v1',
  model: 'gpt-audio', voice: 'alloy', instructions: '', ...patch,
})

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64)])

const harness = (coach: VoiceCoach | undefined, channel: {nativeVoice?: boolean; supportsNativeVoice?: (media: {name: string}) => boolean} = {}) => {
  const state: {receipts: Array<{id: string}>; sessionId?: string} = { receipts: [] }
  const store = { read: () => state as never, write: async (value: unknown) => { Object.assign(state, value) } }
  const submit = vi.fn(() => ({ admitted: Promise.resolve(), result: Promise.resolve({ text: 'agent reply', reason: 'ended' }) }))
  const host = {
    async inspect() { return undefined },
    async open() { return { id: 'channels-voice-1', isLive: () => true, submit, cancel() {}, async close() {} } },
  }
  const sent: Array<[string,string]> = []
  const bridge = new ChannelBridge(host as never, store as never, undefined, () => {}, coach)
  const message = {
    id: 'qqbot:voice-1', text: '[QQ 附件 · audio/wav · word.wav]\n本地路径：/tmp/word.wav',
    audio: [{ name: 'word.wav', mimeType: 'audio/wav', bytes: wav }],
    responding: <T>(callback: () => Promise<T>) => callback(),
    async send(text: string) { sent.push(['text', text]) },
    async sendFile(media: {name: string}) { sent.push(['file', media.name]) },
    async sendVoice(media: {name: string}) { sent.push(['voice', media.name]) },
    ...channel,
  }
  return { bridge, message, sent, submit }
}

it('sends the recording to the audio model and plays its answer back', async () => {
  const fetch = speechFetch()
  vi.stubGlobal('fetch', fetch)
  const { bridge, message, sent, submit } = harness(createVoiceCoach(settings(), 'sk-test'))
  try {
    await bridge.receive({ ...message } as never)
    await bridge.drain()
  } finally { await bridge.close() }

  // One upstream call: the audio itself, asking for text and audio back.
  expect(fetch).toHaveBeenCalledOnce()
  const body = JSON.parse(String((fetch.mock.calls[0] as unknown[])[1] && ((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body))
  expect(body.model).toBe('gpt-audio')
  expect(body.modalities).toEqual(['text','audio'])
  expect(body.messages.at(-1).content[0].type).toBe('input_audio')
  // The answer goes out as voice, and the transcript is the text reply.
  expect(sent.filter(([kind]) => kind === 'voice')).toHaveLength(1)
  expect(sent.find(([kind]) => kind === 'text')?.[1]).toContain('think')
  // The Agent is never asked to handle a voice message.
  expect(submit).not.toHaveBeenCalled()
})

it('reports the real reason when the model cannot answer', async () => {
  vi.stubGlobal('fetch', speechFetch({ status: 400 }))
  const { bridge, message, sent } = harness(createVoiceCoach(settings(), 'sk-test'))
  try {
    await bridge.receive({ ...message } as never)
    await bridge.drain()
  } finally { await bridge.close() }
  expect(sent.some(([kind]) => kind === 'voice')).toBe(false)
  expect(sent[0]?.[1]).toContain('语音没能送出去')
  expect(sent[0]?.[1]).toContain('400')
  expect(sent[0]?.[1]).toContain('audio output')
})

it('falls back to an audio file when the channel has no native voice', async () => {
  vi.stubGlobal('fetch', speechFetch())
  const { bridge, message, sent } = harness(createVoiceCoach(settings(), 'sk-test'), { nativeVoice: false })
  try {
    await bridge.receive({ ...message } as never)
    await bridge.drain()
  } finally { await bridge.close() }
  expect(sent.some(([kind]) => kind === 'file')).toBe(true)
})

it('leaves voice to the Agent when speech is disabled', async () => {
  const fetch = speechFetch()
  vi.stubGlobal('fetch', fetch)
  const { bridge, message, submit } = harness(createVoiceCoach(settings(), undefined))
  try {
    await bridge.receive({ ...message } as never)
    await bridge.drain()
  } finally { await bridge.close() }
  expect(fetch).not.toHaveBeenCalled()
  expect(submit).toHaveBeenCalledOnce()
})

it('passes a caller-supplied instruction and sends none by default', async () => {
  const fetch = speechFetch()
  vi.stubGlobal('fetch', fetch)
  const withRules = harness(createVoiceCoach(settings({ instructions: 'Correct my /θ/.' }), 'sk-test'))
  try {
    await withRules.bridge.receive({ ...withRules.message } as never)
    await withRules.bridge.drain()
  } finally { await withRules.bridge.close() }
  const first = JSON.parse(String(((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body))
  expect(first.messages[0]).toEqual({ role: 'system', content: 'Correct my /θ/.' })

  const plain = harness(createVoiceCoach(settings(), 'sk-test'))
  try {
    await plain.bridge.receive({ ...plain.message } as never)
    await plain.bridge.drain()
  } finally { await plain.bridge.close() }
  const second = JSON.parse(String(((fetch.mock.calls[1] as unknown[])[1] as RequestInit).body))
  expect(second.messages.some((entry: {role: string}) => entry.role === 'system')).toBe(false)
})

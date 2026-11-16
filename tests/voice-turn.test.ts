import {it,expect,vi} from 'vitest'
import {ChannelBridge} from '../src/plugin/bridge.js'
import {createVoiceCoach,type VoiceCoach} from '../src/plugin/voice/index.js'
import type { VoiceHandler } from '../src/plugin/voice/tool.js'
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
  const controller = new AbortController()
  const submit = vi.fn((id: string, _text: string, _progress: unknown, _interactions: unknown, _media: unknown, _stream: unknown, _notice: unknown, voice?: VoiceHandler) => ({ admitted: Promise.resolve(), result: Promise.resolve().then(async () => {
    if (!voice) return { text: 'agent reply', reason: 'ended' }
    try {
      const value = JSON.parse(await voice({ inputId: id, sessionId: 'channels-voice-1', turn: 1, callId: 'listen-1', signal: controller.signal, current: () => !controller.signal.aborted, context: 'Project: English practice. Previous user: read this sentence. Current accompanying text.' }))
      return { text: value.text, reason: 'ended' }
    } catch (error) { return { text: `语音没能送出去：${String(error)}`, reason: 'ended' } }
  }) }))
  const host = {
    async inspect() { return undefined },
    async open() { return { id: 'channels-voice-1', isLive: () => true, submit, cancel() { controller.abort() }, async close() {} } },
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
  return { bridge, message, sent, submit, state }
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
  expect(body.messages.at(-1).content.at(-1).type).toBe('input_audio')
  // The answer goes out as voice, and the transcript is the text reply.
  expect(sent.filter(([kind]) => kind === 'voice')).toHaveLength(1)
  expect(sent.find(([kind]) => kind === 'text')?.[1]).toContain('think')
  // The same Agent handles the turn and provides relevant prior context.
  expect(submit).toHaveBeenCalledOnce()
  expect(body.messages.at(-1).content[0].text).toContain('Previous user')
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
  const { bridge, message, submit } = harness(createVoiceCoach(settings({ enabled: false }), undefined))
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

it('reports an enabled feature with a missing key without claiming to hear audio', async () => {
  const fetch = speechFetch(); vi.stubGlobal('fetch', fetch)
  const {bridge,message,sent}=harness(createVoiceCoach(settings(), undefined))
  try { await bridge.receive(message as never); await bridge.drain() } finally { await bridge.close() }
  expect(fetch).not.toHaveBeenCalled()
  expect(sent.at(-1)?.[1]).toContain('语音凭据未设置')
})

it('declares the byte-detected WAV format even with an incorrect name and MIME', async () => {
  const fetch=speechFetch();vi.stubGlobal('fetch',fetch)
  const coach=createVoiceCoach(settings(),'test')
  await coach.turn({clip:{name:'wrong.mp3',mimeType:'audio/mpeg',bytes:wav},signal:new AbortController().signal})
  const body=JSON.parse(String(((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body))
  expect(body.messages[0].content[0].input_audio.format).toBe('wav')
})

it('aborts an in-flight request on cancel while channel admission stays responsive', async () => {
  let signal: AbortSignal | undefined
  const fetch=vi.fn(async (_url: unknown, init?:RequestInit) => {
    signal=init?.signal as AbortSignal
    return await new Promise<Response>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}))
  });vi.stubGlobal('fetch',fetch)
  const {bridge,message,sent}=harness(createVoiceCoach(settings(),'test'))
  try {
    await bridge.receive(message as never)
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce())
    await bridge.receive({...message,id:'cancel-1',text:'/cancel',audio:undefined} as never)
    await bridge.drain()
    expect(signal?.aborted).toBe(true)
    expect(sent.some(([kind])=>kind==='voice'||kind==='file')).toBe(false)
  }finally{await bridge.close()}
})

it.each(['仅有转写、没有可下载的真实录音。','录音超过 10 MiB，未发送到音频模型。'])('surfaces unavailable audio: %s',async issue=>{
  const fetch=speechFetch();vi.stubGlobal('fetch',fetch)
  const {bridge,message,sent}=harness(createVoiceCoach(settings(),'test'))
  try{await bridge.receive({...message,audio:[],audioIssue:issue} as never);await bridge.drain()}finally{await bridge.close()}
  expect(fetch).not.toHaveBeenCalled();expect(sent.at(-1)?.[1]).toContain(issue)
})

it('decodes an actual synthetic SILK recording with the installed optional dependency', async()=>{
  const {encode}=await import('silk-wasm')
  const {decodeSilkToWav}=await import('../src/plugin/voice/silk.js')
  const pcm=Buffer.alloc(16000*2/5)
  for(let i=0;i<pcm.length/2;i++)pcm.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*440*i/16000)),i*2)
  const encoded=await encode(pcm,16000)
  const decoded=await decodeSilkToWav(Buffer.from(encoded.data),new AbortController().signal)
  expect(decoded.ok).toBe(true)
  if(decoded.ok){expect(decoded.wav.subarray(0,4).toString()).toBe('RIFF');expect(decoded.wav.length).toBeGreaterThan(44)}
})

it('does not accept a late provider reply after disconnect',async()=>{
  let complete!: (value:Response)=>void
  const fetch=vi.fn(()=>new Promise<Response>(resolve=>{complete=resolve}));vi.stubGlobal('fetch',fetch)
  const {bridge,message,sent}=harness(createVoiceCoach(settings(),'test'))
  try{
    await bridge.receive(message as never);await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce())
    bridge.setConnected(false)
    complete(new Response(JSON.stringify({choices:[{message:{audio:{data:replyAudio.toString('base64'),transcript:'late'}}}]})))
    await bridge.drain();expect(sent).toHaveLength(0)
  }finally{await bridge.close()}
})

it('keeps a durable uncertain receipt and never retries an ambiguous voice upload',async()=>{
  vi.stubGlobal('fetch',speechFetch())
  const {bridge,message,state}=harness(createVoiceCoach(settings(),'test'))
  const upload=vi.fn(async()=>{throw new Error('connection lost after upload')})
  try{
    await bridge.receive({...message,sendVoice:upload} as never);await bridge.drain()
    await bridge.receive({...message,sendVoice:upload} as never);await bridge.drain()
    expect(upload).toHaveBeenCalledOnce()
    expect(state.receipts[0]).toMatchObject({media:[{delivery:'uncertain',mode:'voice'}]})
  }finally{await bridge.close()}
})

it('reports text-only provider responses as failure instead of pretending audio was returned',async()=>{
  vi.stubGlobal('fetch',speechFetch({audio:false}))
  const {bridge,message,sent}=harness(createVoiceCoach(settings(),'test'))
  try{await bridge.receive(message as never);await bridge.drain()}finally{await bridge.close()}
  expect(sent.some(([kind])=>kind==='voice'||kind==='file')).toBe(false)
  expect(sent.at(-1)?.[1]).toContain('没有音频数据')
})

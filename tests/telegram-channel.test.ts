import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramApi, TelegramError, supportsTelegramVoice } from '../src/channels/telegram-api.js'
import { TelegramAdapter, splitTelegramText } from '../src/channels/telegram.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { RouteState } from '../src/channels/state.js'
import { opusFixture } from './voice-fixture.js'

const credential = {token:'123:private-token',botId:'123',ownerUserId:'456'}
const channel = {id:'tg',kind:'telegram',botId:'123',ownerUserId:'456'}
const cleanup: Array<()=>Promise<unknown>> = []
afterEach(async()=>{for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks()})
const inbound = (id:number, extra = {}) => ({update_id:id,message:{message_id:id,from:{id:456,is_bot:false},chat:{id:456,type:'private'},text:'task',...extra}})
function setup(batch: unknown[], receive?: (m: ChannelMessage)=>Promise<void>) {
  const api = new TelegramApi(), messages: ChannelMessage[] = [], store = {state:{seen:[]} as RouteState,save:vi.fn(async()=>{})}
  let polled = false
  const request = vi.spyOn(api,'request').mockImplementation(async(_token,method,_body,signal)=>{
    if (method === 'getMe') return {id:123,is_bot:true}
    if (method !== 'getUpdates') return true
    if (!polled) { polled=true; return batch }
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  })
  const adapter = new TelegramAdapter(credential,store,receive ?? (async m=>{messages.push(m)}),()=>{},api)
  cleanup.push(()=>adapter.stop())
  return {api,adapter,store,messages,request}
}
it('accepts only owner private text, ignores edited updates, rejects attachment captions and persists offsets',async()=>{
  const {adapter,store,messages,request} = setup([
    inbound(1,{from:{id:999,is_bot:false}}),inbound(2,{chat:{id:456,type:'group'}}),
    inbound(3,{from:{id:456,is_bot:true}}),inbound(4,{chat:{id:999,type:'private'}}),
    {update_id:5,edited_message:inbound(5).message},
    inbound(6,{text:undefined,photo:[],caption:'do not execute'}),inbound(7),
  ])
  await adapter.start(); await expect.poll(()=>store.state.channelCursor).toBe('8')
  expect(messages.map(m=>m.text)).toEqual(['task'])
  expect(store.state.seen).toContain('telegram:6')
  expect(request.mock.calls.filter(c=>c[1]==='sendMessage')).toHaveLength(1)
  await messages[0]!.send('hello')
  expect(request).toHaveBeenLastCalledWith(credential.token,'sendMessage',{chat_id:'456',text:'hello'},expect.any(AbortSignal))
  const scheduled = await adapter.scheduledMessage('schedule:test','job')
  expect(scheduled.id).toBe('schedule:test')
  await adapter.stop()
  await expect(adapter.scheduledMessage('no','no')).rejects.toThrow('not connected')
})
it('routes image, file and native voice sends for inbound and proactive owner messages',async()=>{
  const {api,adapter,messages}=setup([inbound(1)])
  const photo=vi.spyOn(api,'photo').mockResolvedValue(undefined),file=vi.spyOn(api,'file').mockResolvedValue(undefined),voice=vi.spyOn(api,'voice').mockResolvedValue(undefined)
  await adapter.start();await expect.poll(()=>messages.length).toBe(1)
  const media={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'}
  for (const message of [messages[0]!,await adapter.scheduledMessage('schedule:image','job')]) {
    expect(message.nativeVoice).toBe(true)
    expect(message.supportsNativeVoice!(media)).toBe(false)
    const cancellation=new AbortController()
    await message.sendImage!(media,cancellation.signal)
    expect(photo).toHaveBeenLastCalledWith(credential.token,credential.ownerUserId,media,expect.any(AbortSignal))
    const signal=photo.mock.calls.at(-1)![3]
    cancellation.abort();expect(signal.aborted).toBe(true)
    await message.sendFile(media)
    const audio={bytes:opusFixture(),name:'voice.ogg',mimeType:'audio/ogg'}
    expect(message.supportsNativeVoice!(audio)).toBe(true)
    const voiceCancellation=new AbortController()
    await message.sendVoice(audio,voiceCancellation.signal)
    expect(voice).toHaveBeenLastCalledWith(credential.token,credential.ownerUserId,audio,expect.any(AbortSignal))
    voiceCancellation.abort();expect(voice.mock.calls.at(-1)![3].aborted).toBe(true)
  }
  expect(photo).toHaveBeenCalledTimes(2);expect(file).toHaveBeenCalledTimes(2);expect(voice).toHaveBeenCalledTimes(2)
})
it('accepts only compatible Telegram voice formats, not renamed WAV or Vorbis',()=>{
  const mp3={bytes:Buffer.from([0xff,0xfb,0x90,0x00,0x00]),name:'voice.mp3',mimeType:'audio/mpeg'}
  const m4aBytes=Buffer.alloc(24);m4aBytes.writeUInt32BE(24);m4aBytes.write('ftypM4A ',4);m4aBytes.write('isomM4A ',16)
  const m4a={bytes:m4aBytes,name:'voice.m4a',mimeType:'audio/mp4'}
  const ogg={bytes:opusFixture(),name:'voice.ogg',mimeType:'audio/ogg'}
  for (const media of [mp3,m4a,ogg]) expect(supportsTelegramVoice(media)).toBe(true)
  for (const media of [{...mp3,name:'voice.wav'},{...mp3,bytes:Buffer.from('RIFF WAVE')},{...m4a,bytes:Buffer.from('not m4a')},{...ogg,bytes:Buffer.from('OggS Vorbis')},{...ogg,bytes:ogg.bytes.subarray(0,-1)}]) expect(supportsTelegramVoice(media)).toBe(false)
})
it('uploads voice multipart once, rejects incompatible audio and honors cancellation',async()=>{
  const fetcher=vi.fn(async()=>Response.json({ok:true,result:true})),api=new TelegramApi(fetcher as typeof fetch)
  const controller=new AbortController(),media={bytes:opusFixture(),name:'voice.ogg',mimeType:'audio/ogg'}
  await api.voice(credential.token,'456',media,controller.signal)
  const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit],body=options.body as FormData
  expect(url).toBe(`https://api.telegram.org/bot${credential.token}/sendVoice`)
  expect(body.get('chat_id')).toBe('456');expect(body.get('voice')).toMatchObject({name:'voice.ogg',type:'audio/ogg'})
  expect(Buffer.from(await (body.get('voice') as Blob).arrayBuffer())).toEqual(media.bytes)
  await expect(api.voice(credential.token,'456',{...media,name:'voice.wav',mimeType:'audio/wav'},controller.signal)).rejects.toThrow('file delivery')
  fetcher.mockRejectedValueOnce(new Error('private token ambiguous send'))
  await expect(api.voice(credential.token,'456',media,controller.signal)).rejects.toThrow('Telegram request failed')
  expect(fetcher).toHaveBeenCalledTimes(2)
  controller.abort()
  await expect(api.voice(credential.token,'456',media,controller.signal)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('preserves emoji and text while respecting UTF-16 message limits',()=>{
  const value='x'.repeat(4095)+'👨‍👩‍👧‍👦'+'y'.repeat(5000)
  const parts=splitTelegramText(value)
  expect(parts.join('')).toBe(value);expect(parts.every(p=>p.length<=4096)).toBe(true)
})
it('stops promptly during pending backend admission',async()=>{
  let release!:()=>void
  const receive=vi.fn(()=>new Promise<void>(r=>{release=r}))
  const {adapter}=setup([inbound(1)],receive)
  await adapter.start();await expect.poll(()=>receive.mock.calls.length).toBe(1)
  await adapter.stop();expect(adapter.state.phase).toBe('stopped');release()
})
it.each([401,403,409])('surfaces terminal Telegram error %s without token leakage',async code=>{
  const {adapter,request}=setup([])
  request.mockRejectedValue(new TelegramError(code))
  await adapter.start();await expect.poll(()=>adapter.state.phase).toBe('failed')
  expect(JSON.stringify(adapter.state)).not.toContain(credential.token)
})
it('never retries ambiguous photo delivery and does not fetch for cancelled media sends',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error(credential.token)})
  const api=new TelegramApi(fetcher as typeof fetch),controller=new AbortController()
  const media={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'}
  await expect(api.photo(credential.token,'456',media,controller.signal)).rejects.toThrow('Telegram request failed')
  expect(fetcher).toHaveBeenCalledTimes(1)
  controller.abort()
  await expect(api.photo(credential.token,'456',media,controller.signal)).rejects.toThrow()
  await expect(api.file(credential.token,'456',media,controller.signal)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('uses JSON and multipart with a fixed origin, sanitized errors and retry-after',async()=>{
  const fetcher=vi.fn(async()=>Response.json({ok:true,result:true}))
  const api=new TelegramApi(fetcher as typeof fetch),signal=new AbortController().signal
  await api.request(credential.token,'sendMessage',{chat_id:'456',text:'hi'},signal)
  expect(fetcher.mock.calls[0]).toMatchObject([`https://api.telegram.org/bot${credential.token}/sendMessage`,{redirect:'error',method:'POST'}])
  await api.file(credential.token,'456',{bytes:Buffer.from('hello'),name:'test.txt',mimeType:'text/plain'},signal)
  const body=(fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body as FormData
  expect(body.get('chat_id')).toBe('456');expect(await (body.get('document') as Blob).text()).toBe('hello')
  await api.photo(credential.token,'456',{bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'},signal)
  const photoCall=fetcher.mock.calls[2] as unknown as [string,RequestInit],photo=photoCall[1].body as FormData
  expect(photoCall[0]).toBe(`https://api.telegram.org/bot${credential.token}/sendPhoto`)
  expect(photoCall[1]).toMatchObject({method:'POST',redirect:'error'})
  expect(photoCall[1].headers).toBeUndefined()
  expect(photo.get('chat_id')).toBe('456');expect(photo.get('document')).toBeNull()
  expect(photo.get('photo')).toMatchObject({name:'result.png',type:'image/png'})
  expect(await (photo.get('photo') as Blob).text()).toBe('image')
  fetcher.mockImplementation(async()=>Response.json({ok:false,error_code:429,description:credential.token,parameters:{retry_after:3}}))
  await expect(api.request(credential.token,'getUpdates',{},signal)).rejects.toMatchObject({code:429,retryAfter:3000,message:'Telegram request failed'})
  fetcher.mockRejectedValue(new Error(credential.token))
  await expect(api.request(credential.token,'getMe',{},signal)).rejects.toThrow('Telegram request failed')
})

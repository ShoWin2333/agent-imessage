import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramApi, TelegramError } from '../src/channels/telegram-api.js'
import { TelegramAdapter, splitTelegramText } from '../src/channels/telegram.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { RouteState } from '../src/channels/state.js'

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
it('uses JSON and multipart with a fixed origin, sanitized errors and retry-after',async()=>{
  const fetcher=vi.fn(async()=>Response.json({ok:true,result:true}))
  const api=new TelegramApi(fetcher as typeof fetch),signal=new AbortController().signal
  await api.request(credential.token,'sendMessage',{chat_id:'456',text:'hi'},signal)
  expect(fetcher.mock.calls[0]).toMatchObject([`https://api.telegram.org/bot${credential.token}/sendMessage`,{redirect:'error',method:'POST'}])
  await api.file(credential.token,'456',{bytes:Buffer.from('hello'),name:'test.txt',mimeType:'text/plain'},signal)
  const body=(fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body as FormData
  expect(body.get('chat_id')).toBe('456');expect(await (body.get('document') as Blob).text()).toBe('hello')
  fetcher.mockImplementation(async()=>Response.json({ok:false,error_code:429,description:credential.token,parameters:{retry_after:3}}))
  await expect(api.request(credential.token,'getUpdates',{},signal)).rejects.toMatchObject({code:429,retryAfter:3000,message:'Telegram request failed'})
  fetcher.mockRejectedValue(new Error(credential.token))
  await expect(api.request(credential.token,'getMe',{},signal)).rejects.toThrow('Telegram request failed')
})

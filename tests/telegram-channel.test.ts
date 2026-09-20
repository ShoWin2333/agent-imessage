import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelegramApi, TelegramError } from '../src/channels/telegram-api.js'
import { TelegramAdapter, splitTelegramText } from '../src/channels/telegram.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { RouteState } from '../src/gateway/state.js'
import { appSchema, loadSecrets, validateConfig } from '../src/app/config.js'
import { Gateway } from '../src/gateway/app.js'
import { startServer } from '../src/app/server.js'

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
it('rejects duplicate bots and invalid owner IDs',async()=>{
  const route={id:'one',cwd:'/tmp',channels:[channel]}
  await expect(validateConfig({routes:[route,{...route,id:'two'}]},false)).rejects.toThrow('unique')
  expect(appSchema.safeParse({routes:[{...route,channels:[{...channel,ownerUserId:'@someone'}]}]}).success).toBe(false)
})
it('saves tokens privately, preserves tokens on blank input and keeps them out of public state',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'telegram-test-')))
  cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const config=appSchema.parse({port:0,stateDir:dir}),file=join(dir,'config.json'),gateway=new Gateway(config,{photon:{}})
  const server=await startServer(file,config,{photon:{}},gateway)
  cleanup.push(()=>gateway.stop());cleanup.push(()=>server.close())
  const state=await(await fetch(server.url+'/api/state')).json()
  const route={id:'project',cwd:dir,enabled:false,channels:[channel]}
  const save=(revision:number,token:string)=>fetch(server.url+'/api/save-route',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify({revision,id:'project',route,telegram:{'project:tg':token}})})
  expect((await save(0,'999:wrong')).status).toBe(400)
  expect((await save(0,credential.token)).status).toBe(200)
  expect((await save(1,'')).status).toBe(200)
  expect((await loadSecrets(file+'.secrets.json')).telegram).toEqual({'123':credential.token})
  expect((await stat(file+'.secrets.json')).mode & 0o777).toBe(0o600)
  expect(await readFile(file,'utf8')).not.toContain(credential.token)
  expect(await(await fetch(server.url+'/api/state')).text()).not.toContain(credential.token)
})

it('routes a Telegram task to the backend, replies, resumes its cursor and isolates a changed owner',async()=>{
  const { BaseBackend } = await import('../src/backends/types.js')
  class Backend extends BaseBackend {
    initialize=async()=>{}
    openSession=vi.fn(async(o: import('../src/backends/types.js').SessionOptions)=>({id:o.id ?? 'test-session',cwd:o.cwd}))
    startTurn=vi.fn(async(sessionId:string)=>{this.onEvent({type:'started',sessionId,turnId:'turn'});return 'turn'})
    cancel=async()=>{}
    close=async()=>{this.onClose()}
  }
  const dir=await realpath(await mkdtemp(join(tmpdir(),'telegram-gateway-')))
  cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const config=appSchema.parse({stateDir:dir,routes:[{id:'project',cwd:dir,channels:[channel]}]})
  const backends: Backend[] = [], offsets:number[] = []
  let batch=[inbound(10)]
  const request=vi.spyOn(TelegramApi.prototype,'request').mockImplementation(async(_token,method,body)=>{
    if (method==='getMe') return {id:123,is_bot:true}
    if (method==='getUpdates') {
      offsets.push((body as Record<string,number>).offset!)
      const result=batch;batch=[];return result
    }
    return true
  })
  const secrets={photon:{},telegram:{'123':credential.token}}
  const gateway=new Gateway(config,secrets,()=>{const b=new Backend();backends.push(b);return b})
  cleanup.push(()=>gateway.stop())
  await gateway.start()
  await expect.poll(()=>backends[0]?.startTurn.mock.calls.length).toBe(1)
  backends[0]!.onEvent({type:'message',sessionId:'test-session',turnId:'turn',id:'answer',text:'Telegram result'})
  backends[0]!.onEvent({type:'completed',sessionId:'test-session',turnId:'turn',status:'completed'})
  await expect.poll(()=>request.mock.calls.some(c=>c[1]==='sendMessage' && (c[2] as Record<string,unknown>).text==='Telegram result')).toBe(true)
  await gateway.stop();offsets.length=0
  await gateway.start()
  await expect.poll(()=>offsets[0]).toBe(11)
  // Changing the authorized owner must not inherit the previous poll cursor/session.
  await gateway.replace(appSchema.parse({...config,routes:[{...config.routes[0],channels:[{...channel,ownerUserId:'789'}]}]}),secrets)
  await expect.poll(()=>offsets.at(-1)).toBe(0)
  expect(backends).toHaveLength(3)
})

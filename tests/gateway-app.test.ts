import { PhotonAccount } from '../src/app/photon.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { get } from 'node:http'
import { join } from 'node:path'
import { Gateway } from '../src/gateway/app.js'
import { BaseBackend, type SessionOptions } from '../src/backends/types.js'
import { appSchema } from '../src/app/config.js'
import { startServer } from '../src/app/server.js'
import { GatewayRouter } from '../src/gateway/router.js'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'
import type { RouteState } from '../src/gateway/state.js'
class Backend extends BaseBackend {
  initialize=vi.fn(async()=>{})
  openSession=vi.fn(async(o:SessionOptions)=>({id:o.id??'session',cwd:o.cwd}))
  startTurn=vi.fn(async(sessionId:string,_text:string)=>{this.onEvent({type:'started',sessionId,turnId:'turn'});return 'turn'})
  cancel=vi.fn(async()=>{})
  close=vi.fn(async()=>{this.onClose()})
}
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{vi.restoreAllMocks();for(const fn of cleanup.splice(0).reverse())await fn()})
async function fixture(){const dir=await realpath(await mkdtemp(join(tmpdir(),'gateway-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir}
const route={id:'one',cwd:'/workspace',projectId:'p',projectSecretEnv:'SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
it('isolates failing routes, owns transport lifecycle and releases state locks',async()=>{
  const dir=await fixture(),config=appSchema.parse({stateDir:dir,routes:[{...route,cwd:dir},{...route,id:'two',projectId:'p2',cwd:join(dir,'missing')},{...route,id:'three',projectId:'p3',cwd:dir}]})
  const backend=new Backend();let end!:()=>void
  const gateway=new Gateway(config,{photon:{one:'secret',two:'secret'}},()=>backend,async()=>({messages:{async *[Symbol.asyncIterator](){await new Promise<void>(r=>{end=r})}},stop:async()=>{end()}}))
  cleanup.push(()=>gateway.stop());await gateway.start()
  expect(gateway.snapshot().map(r=>r.phase)).toEqual(['listening','failed','failed'])
  await gateway.stop();expect(backend.close).toHaveBeenCalledTimes(1)
  await gateway.start();expect(gateway.snapshot()[0]?.phase).toBe('listening')
})
it('serves the native API and enforces loopback Host, Origin and CSRF before mutations',async()=>{
  const dir=await fixture(),file=join(dir,'config.json'),config=appSchema.parse({port:0,stateDir:dir})
  const gateway=new Gateway(config,{photon:{}})
  const server=await startServer(file,config,{photon:{}},gateway);cleanup.push(()=>server.close());cleanup.push(()=>gateway.stop())
  expect((await fetch(server.url)).status).toBe(404)
  const firstState=await fetch(server.url+'/api/state')
  const state=await firstState.json() as {csrf:string}
  const unchanged=await fetch(server.url+'/api/state',{headers:{'if-none-match':firstState.headers.get('etag')!}})
  expect(unchanged.status).toBe(304)
  expect(await unchanged.text()).toBe('')
  for (const asset of ['/app.js','/style.css','/brand.png']) expect((await fetch(server.url+asset)).status).toBe(404)
  expect(await new Promise<number | undefined>((resolve,reject)=>{get(server.url+'/api/state',{headers:{Host:'attacker.test'}},response=>{response.resume();resolve(response.statusCode)}).on('error',reject)})).toBe(403)
  expect((await fetch(server.url+'/api/stop',{method:'POST',headers:{origin:'https://evil.test'}})).status).toBe(403)
  const headers={origin:server.url,'content-type':'application/json','x-agent-token':state.csrf}
  expect((await fetch(server.url+'/api/save',{method:'POST',headers,body:JSON.stringify({revision:0,config,cursorApiKey:'private-key'})})).status).toBe(200)
  expect((await fetch(server.url+'/api/save',{method:'POST',headers,body:JSON.stringify({revision:0,config})})).status).toBe(409)
  const response=await (await fetch(server.url+'/api/state')).text()
  expect(response).not.toContain('private-key');expect(response).toContain('"hasCursorKey":true')
})
it('keeps session history route-scoped and routes shared questions, files and voice for any backend',async()=>{
  const dir=await fixture();await writeFile(join(dir,'voice.m4a'),'audio')
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:async()=>{}}
  const router=new GatewayRouter(backend,{...route,cwd:dir,backend:'dsh'},store,1000);cleanup.push(()=>router.close());router.setConnected(true)
  const send=vi.fn(async(_s:string)=>{}),voice=vi.fn(async()=>{})
  let seq=0;const channel=(text:string):SpectrumInboundMessage=>({id:String(++seq),text,send,sendVoice:voice,sendFile:async()=>{},responding:fn=>fn()})
  await router.receive(channel('hello'))
  const media=await backend.onRequest({kind:'tool',sessionId:'session',turnId:'turn',payload:{tool:'send_imessage_voice',arguments:{path:'voice.m4a'}}})
  expect(media).toMatchObject({success:true});expect(voice).toHaveBeenCalledTimes(1)
  const question=backend.onRequest({kind:'tool',sessionId:'session',turnId:'turn',payload:{tool:'ask_imessage_user',arguments:{question:'Which branch?'}}})
  await expect.poll(()=>send.mock.calls.at(-1)?.[0]).toContain('/answer')
  const id=send.mock.calls.at(-1)![0].match(/\/answer ([\w-]+)/)![1]
  await router.receive(channel(`/answer ${id} {"answer":"main"}`));expect(await question).toMatchObject({success:true})
  backend.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(()=>router.snapshot().busy).toBe(false)
  await router.receive(channel('/new'));await router.receive(channel('/switch other'));expect(store.state.threadId).toBeUndefined()
  await router.receive(channel('/switch session'));expect(store.state.threadId).toBe('session')
})

it('lists Photon projects and saves selected credentials only with their matching project',async()=>{
  const dir=await fixture(),file=join(dir,'config.json')
  const config=appSchema.parse({port:0,stateDir:dir,routes:[{...route,cwd:dir,enabled:false}]})
  const gateway=new Gateway(config,{photon:{one:'old-secret'}})
  vi.spyOn(PhotonAccount.prototype,'projects').mockResolvedValue([{id:'new-project',name:'Existing project'}])
  vi.spyOn(PhotonAccount.prototype,'select').mockResolvedValue({projectId:'new-project',secret:'new-private-secret',assignedPhoneNumber:route.assignedPhoneNumber})
  const server=await startServer(file,config,{photon:{one:'old-secret'}},gateway)
  cleanup.push(()=>server.close());cleanup.push(()=>gateway.stop())
  const state=await (await fetch(server.url+'/api/state')).json()
  const post=(path:string,data:unknown)=>fetch(server.url+path,{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify(data)})
  expect(await (await post('/api/photon/projects',{})).json()).toEqual({projects:[{id:'new-project',name:'Existing project'}]})
  const selected=await (await post('/api/photon/select',{id:'one',name:'one',sender:route.senderPhoneNumber,projectId:'new-project'})).text()
  expect(selected).not.toContain('new-private-secret')
  const next={...config,routes:[{...config.routes[0],projectId:'new-project'}]}
  expect((await post('/api/save',{revision:0,config:next})).status).toBe(200)
  const {readFile}=await import('node:fs/promises')
  expect(JSON.parse(await readFile(file+'.secrets.json','utf8')).photon.one).toBe('new-private-secret')
})
it('applies one project without closing another backend or changing its configuration',async()=>{
  const dir=await fixture()
  const config=appSchema.parse({port:0,stateDir:dir,routes:[{...route,cwd:dir},{...route,id:'two',projectId:'p2',assignedPhoneNumber:'+15557654322',cwd:dir}]})
  const backends:Backend[]=[]
  const secrets={photon:{one:'secret',two:'secret'}}
  const gateway=new Gateway(config,secrets,()=>{const b=new Backend();backends.push(b);return b},async()=>{
    let end!:()=>void;const done=new Promise<void>(r=>{end=r})
    return {messages:{async *[Symbol.asyncIterator](){await done}},stop:async()=>end()}
  })
  cleanup.push(()=>gateway.stop());await gateway.start()
  const file=join(dir,'config.json'),server=await startServer(file,config,secrets,gateway);cleanup.push(()=>server.close())
  const state=await (await fetch(server.url+'/api/state')).json()
  const next={...config.routes[0],label:'Updated project'}
  const response=await fetch(server.url+'/api/save-route',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify({revision:0,id:'one',route:next,photon:{two:'must-not-change'}})})
  expect(response.status).toBe(200)
  expect(backends[0]!.close).not.toHaveBeenCalled()
  expect(backends[1]!.close).not.toHaveBeenCalled()
  expect(backends).toHaveLength(2)
  const {readFile}=await import('node:fs/promises')
  const saved=JSON.parse(await readFile(file,'utf8'))
  expect(saved.routes[1]).toEqual(config.routes[1])
  expect(JSON.parse(await readFile(file+'.secrets.json','utf8')).photon.two).toBe('secret')
})

it('exposes receipt and session admission stalls before Agent starts, and bounds activity text and count',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:async()=>{}}
  const router=new GatewayRouter(backend,route,store);cleanup.push(()=>router.close());router.setConnected(true)
  let release!:(value:{id:string;cwd:string})=>void
  backend.openSession.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  const channel=(id:string,text:string):SpectrumInboundMessage=>({id,text,send:async()=>{},sendVoice:async()=>{},sendFile:async()=>{},responding:fn=>fn()})
  const receiving=router.receive(channel('first','x'.repeat(9000)))
  await expect.poll(()=>router.snapshot().activity.at(-1)?.stage).toBe('opening-session')
  expect(router.snapshot().activity.find(e=>e.stage==='received')?.text?.length).toBeLessThan(8100)
  const queued=router.receive(channel('second','queued'))
  expect(router.snapshot().activity.at(-1)).toMatchObject({stage:'received',messageId:'second'})
  release({id:'session',cwd:route.cwd});await receiving;await queued
  expect(router.snapshot().activity.some(e=>e.stage==='busy' && e.messageId==='second')).toBe(true)
  for(let i=0;i<220;i++) await router.receive(channel('first','duplicate'))
  expect(router.snapshot().activity).toHaveLength(200)
  expect(router.snapshot().activity.at(-1)?.stage).toBe('duplicate')
})

it('records generated replies and failed delivery without exposing raw provider errors',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:async()=>{}}
  const router=new GatewayRouter(backend,route,store);cleanup.push(()=>router.close());router.setConnected(true)
  await router.receive({id:'task',text:'hello',send:async()=>{throw new Error('secret-provider-token')},sendVoice:async()=>{},sendFile:async()=>{},responding:fn=>fn()})
  backend.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'answer',text:'a reply'})
  backend.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(()=>router.snapshot().activity.some(e=>e.stage==='send-failed')).toBe(true)
  const events=router.snapshot().activity
  expect(events.find(e=>e.stage==='response')).toMatchObject({messageId:'task',text:'a reply'})
  expect(events.find(e=>e.stage==='sent')).toBeUndefined()
  expect(JSON.stringify(events)).not.toContain('secret-provider-token')
})

it('shows shared elapsed phases, sends only one delayed notice and never delivers previews as final answers',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:async()=>{}}
  const router=new GatewayRouter(backend,{...route,backend:'dsh'},store,1000,10);cleanup.push(()=>router.close());router.setConnected(true)
  const send=vi.fn(async(_text:string)=>{})
  await router.receive({id:'long-task',text:'hello',send,sendVoice:async()=>{},sendFile:async()=>{},responding:fn=>fn()})
  backend.onEvent({type:'progress',sessionId:'session',turnId:'turn',phase:'tool-running'})
  backend.onEvent({type:'preview',sessionId:'session',turnId:'turn',id:'part',text:'unfinished'})
  await expect.poll(()=>send.mock.calls.length).toBe(1)
  expect(send.mock.calls[0]![0]).toContain('正在执行工具')
  expect(router.snapshot().current?.phase).toBe('正在执行工具')
  backend.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'final',text:'finished'})
  backend.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(()=>send.mock.calls.length).toBe(2)
  expect(send.mock.calls[1]![0]).toBe('finished')
  expect(router.snapshot().activity.find(e=>e.stage==='completed')?.text).toContain('首段文本')
  expect(router.snapshot().current).toBeUndefined()
})

it('releases a task disconnected during session setup and admits a later task',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:async()=>{}}
  const router=new GatewayRouter(backend,route,store);cleanup.push(()=>router.close());router.setConnected(true)
  let release!:(value:{id:string;cwd:string})=>void
  backend.openSession.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
  const channel=(id:string):SpectrumInboundMessage=>({id,text:'hello',send:async()=>{},sendVoice:async()=>{},sendFile:async()=>{},responding:fn=>fn()})
  const first=router.receive(channel('first'))
  await expect.poll(()=>router.snapshot().busy).toBe(true)
  router.setConnected(false);release({id:'session',cwd:route.cwd});await first
  expect(router.snapshot().busy).toBe(false);expect(backend.startTurn).not.toHaveBeenCalled()
  router.setConnected(true);await router.receive(channel('second'));expect(backend.startTurn).toHaveBeenCalledTimes(1)
})

it('admits authenticated desktop messages into the selected route without sending to remote channels',async()=>{
  const dir=await fixture(),config=appSchema.parse({port:0,stateDir:dir,routes:[{...route,cwd:dir}]})
  const backend=new Backend(),remoteSend=vi.fn(async()=>{})
  let end!:()=>void
  const gateway=new Gateway(config,{photon:{one:'secret'}},()=>backend,async()=>({messages:{async *[Symbol.asyncIterator](){await new Promise<void>(r=>{end=r})}},scheduledMessage:async()=>({id:'remote',text:'',send:remoteSend,sendFile:async()=>{},sendVoice:async()=>{},responding:fn=>fn()}),stop:async()=>{end()}}))
  cleanup.push(()=>gateway.stop());await gateway.start()
  const server=await startServer(join(dir,'config.json'),config,{photon:{one:'secret'}},gateway);cleanup.push(()=>server.close())
  const state=await (await fetch(server.url+'/api/state')).json()
  const body={routeId:'one',channelId:'imessage',text:'hello from desktop'}
  expect((await fetch(server.url+'/api/conversations/send',{method:'POST',headers:{origin:server.url,'content-type':'application/json'},body:JSON.stringify(body)})).status).toBe(403)
  const post=(input:unknown)=>fetch(server.url+'/api/conversations/send',{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify(input)})
  expect((await post({...body,channelId:'unknown'})).status).toBe(400)
  expect((await post({...body,text:' '})).status).toBe(400)
  expect((await post(body)).status).toBe(200)
  expect(backend.startTurn).toHaveBeenLastCalledWith('session','hello from desktop')
  backend.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'answer',text:'local answer'})
  backend.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(()=>gateway.snapshot()[0]?.channels[0]?.tasks?.[0]?.delivery).toBe('sent')
  expect(remoteSend).not.toHaveBeenCalled()
  expect(gateway.snapshot()[0]?.channels[0]?.tasks?.[0]).toMatchObject({origin:'desktop',sessionId:'session',result:'local answer'})
})

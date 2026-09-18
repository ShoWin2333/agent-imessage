import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WeixinApi, WeixinError, weixinUrl } from '../src/channels/weixin-api.js'
import { WeixinAdapter, splitWeixinText } from '../src/channels/weixin.js'
import { WeixinLogin } from '../src/app/weixin.js'
import { appSchema, validateConfig } from '../src/app/config.js'
import { StateStore, type RouteState } from '../src/gateway/state.js'
import { Gateway } from '../src/gateway/app.js'
import { startServer } from '../src/app/server.js'
import { BaseBackend, type SessionOptions } from '../src/backends/types.js'
import type { ChannelMessage } from '../src/channels/types.js'

beforeEach(()=>{vi.spyOn(WeixinApi.prototype,'notify').mockResolvedValue({ret:0})})
const cleanup: Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks()})
async function fixture(){const dir=await realpath(await mkdtemp(join(tmpdir(),'weixin-test-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}));return dir}
const credential={token:'private-bot-token',accountId:'bot@im.bot',ownerUserId:'owner@im.user',baseUrl:'https://ilinkai.weixin.qq.com/'}
const legacy={id:'project',cwd:'/workspace',projectId:'photon',projectSecretEnv:'PHOTON_TEST',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
const inbound=(id:string,text:string,extra={})=>({message_id:id,from_user_id:credential.ownerUserId,to_user_id:credential.accountId,message_type:1,context_token:'reply-context',item_list:[{type:1,text_item:{text}}],...extra})

it('uses iLink wire fields, local QR binding and authenticated outbound context',async()=>{
  const calls: Array<{url:string;init:RequestInit}>=[]
  const api=new WeixinApi((async(url,init)=>{
    calls.push({url:String(url),init:init!})
    return Response.json(String(url).includes('get_bot_qrcode') ? {qrcode:'qr-secret',qrcode_img_content:'https://weixin.qq.com/bind?code=secret'} : {ret:0})
  }) as typeof fetch)
  expect(await api.begin()).toEqual({qrcode:'qr-secret',url:'https://weixin.qq.com/bind?code=secret'})
  await api.send(credential,credential.ownerUserId,'context-private','hello',new AbortController().signal)
  expect(calls[0]!.url).toContain('ilink/bot/get_bot_qrcode?bot_type=3')
  expect(calls[0]!.init.redirect).toBe('error')
  expect(calls[1]!.init.headers).toMatchObject({Authorization:'Bearer private-bot-token',AuthorizationType:'ilink_bot_token'})
  expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({msg:{to_user_id:credential.ownerUserId,context_token:'context-private',message_type:2,item_list:[{type:1,text_item:{text:'hello'}}]}})
})
it('rejects untrusted provider URLs and turns expired tokens into a fixed public error',async()=>{
  for (const url of ['http://ilinkai.weixin.qq.com/','https://weixin.qq.com.evil.test/','https://user:pass@weixin.qq.com/','https://127.0.0.1/']) expect(()=>weixinUrl(url)).toThrow()
  const api=new WeixinApi((async()=>Response.json({ret:-14,errmsg:'private provider details'})) as typeof fetch)
  await expect(api.updates(credential,'',new AbortController().signal)).rejects.toMatchObject({code:'auth',message:'微信凭据已失效，请重新扫码绑定。'})
})
it('binds a bot via QR without exposing its credentials in login status',async()=>{
  const save=vi.fn(async()=>{})
  const api=new WeixinApi()
  vi.spyOn(api,'begin').mockResolvedValue({qrcode:'qr-token',url:'https://weixin.qq.com/bind'})
  vi.spyOn(api,'poll').mockResolvedValue({status:'confirmed',bot_token:credential.token,ilink_bot_id:credential.accountId,ilink_user_id:credential.ownerUserId,baseurl:credential.baseUrl})
  const login=new WeixinLogin(save,api);cleanup.push(()=>login.cancel())
  await login.begin()
  await expect.poll(()=>login.snapshot().phase).toBe('connected')
  expect(save).toHaveBeenCalledWith(credential)
  expect(JSON.stringify(login.snapshot())).not.toContain(credential.token)
  expect(login.snapshot().qr).toBe('')
})
it('filters non-owner, bot, wrong-recipient and attachment messages; persists poll cursor and bounds replies',async()=>{
  const api=new WeixinApi(), messages:ChannelMessage[]=[], store={state:{seen:[]} as RouteState,save:vi.fn(async()=>{})}
  vi.spyOn(api,'updates').mockResolvedValueOnce({msgs:[inbound('bad','foreign',{from_user_id:'other'}),inbound('echo','echo',{message_type:2}),inbound('wrong','wrong',{to_user_id:'other-bot'}),inbound('attachment','partial',{item_list:[{type:1,text_item:{text:'partial'}},{type:2,image_item:{}}]}),inbound('ok','task')],get_updates_buf:'next-cursor'}).mockImplementation(async(_c,cursor,signal)=>{
    expect(cursor).toBe('next-cursor')
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  })
  const send=vi.spyOn(api,'send').mockResolvedValue({ret:0})
  const adapter=new WeixinAdapter(credential,store,async m=>{messages.push(m)},()=>{},api);cleanup.push(()=>adapter.stop())
  await adapter.start();await expect.poll(()=>store.state.channelCursor).toBe('next-cursor')
  expect(messages.map(m=>m.text)).toEqual(['task'])
  expect(send).toHaveBeenCalledWith(credential,credential.ownerUserId,'reply-context',expect.stringContaining('目前支持文字'),expect.any(AbortSignal))
  send.mockClear();await messages[0]!.send('x'.repeat(4000))
  expect(send.mock.calls).toHaveLength(3)
  expect(send.mock.calls.every(c=>c[3].length<=1800)).toBe(true)
  await adapter.stop();expect(adapter.state.phase).toBe('stopped')
})
it('marks expired credentials failed instead of endlessly retrying',async()=>{
  const api=new WeixinApi();vi.spyOn(api,'updates').mockRejectedValue(new WeixinError('auth','expired'))
  const adapter=new WeixinAdapter(credential,{state:{seen:[]},save:async()=>{}},async()=>{},()=>{},api)
  cleanup.push(()=>adapter.stop());await adapter.start()
  await expect.poll(()=>adapter.state.phase).toBe('failed')
  expect(api.updates).toHaveBeenCalledTimes(1)
})
it('validates weixin-only projects and rejects duplicate accounts across projects',async()=>{
  const route={id:'one',cwd:'/workspace',channels:[{kind:'weixin',id:'wechat',accountId:'bot'}]}
  expect((await validateConfig({routes:[route]},false)).routes[0]!.channels).toHaveLength(1)
  await expect(validateConfig({routes:[route,{...route,id:'two'}]},false)).rejects.toThrow('unique')
  await expect(validateConfig({routes:[{...route,channels:[]}]},false)).rejects.toThrow()
  await expect(validateConfig({routes:[{...route,channels:[...route.channels,...route.channels]}]},false)).rejects.toThrow()
})
class Backend extends BaseBackend {
  constructor(private readonly id:string){super()}
  initialize=vi.fn(async()=>{})
  openSession=vi.fn(async(o:SessionOptions)=>({id:o.id??this.id,cwd:o.cwd}))
  startTurn=vi.fn(async(sessionId:string,_text:string)=>{this.onEvent({type:'started',sessionId,turnId:'turn'});return 'turn'})
  cancel=vi.fn(async()=>{})
  close=vi.fn(async()=>{this.onClose()})
}
it('keeps stopped WeChat accounts reserved until explicit unbinding, then allows reassignment',async()=>{
  const one={id:'one',label:'First Agent',cwd:'/workspace',enabled:false,channels:[{kind:'weixin',id:'wechat',accountId:'bot'}]}
  const two={...one,id:'two',label:'Second Agent'}
  await expect(validateConfig({routes:[one,two]},false)).rejects.toThrow('First Agent')
  const config=await validateConfig({routes:[{...one,channels:[]},two]},false)
  expect(config.routes[0]!.channels).toEqual([])
  expect(config.routes[1]!.channels).toHaveLength(1)
  await expect(validateConfig({routes:[{...one,enabled:true,channels:[]}]},false)).rejects.toThrow()
})

it('preserves legacy iMessage state when adding Weixin and isolates approvals between channels',async()=>{
  const dir=await fixture(), old={...legacy,cwd:dir}, store=await StateStore.open(dir,old)
  store.state.threadId='legacy-session';store.state.sessions=['legacy-session'];await store.save();await store.close()
  const config=appSchema.parse({stateDir:dir,routes:[{...old,channels:[{kind:'imessage',id:'imessage',projectId:old.projectId,projectSecretEnv:old.projectSecretEnv,senderPhoneNumber:old.senderPhoneNumber,assignedPhoneNumber:old.assignedPhoneNumber},{kind:'weixin',id:'wechat',accountId:credential.accountId}]}]})
  const backends:Backend[]=[], imessageSend=vi.fn(async(_s:string)=>{}), weixinSend=vi.spyOn(WeixinApi.prototype,'send').mockResolvedValue({ret:0})
  const batches: unknown[]=[inbound('w1','weixin task')]
  vi.spyOn(WeixinApi.prototype,'updates').mockImplementation(async()=>({msgs:batches.splice(0),get_updates_buf:'cursor'}))
  const gateway=new Gateway(config,{photon:{'project:imessage':'secret'},weixin:{[credential.accountId]:credential}},()=>{const b=new Backend(`session-${backends.length}`);backends.push(b);return b},async()=>{
    let end!:()=>void;const done=new Promise<void>(resolve=>{end=resolve})
    return {messages:{async *[Symbol.asyncIterator](){yield {id:'i1',text:'imessage task',send:imessageSend,sendFile:async()=>{},sendVoice:async()=>{},responding:fn=>fn()} as ChannelMessage;await done}},stop:async()=>end()}
  })
  cleanup.push(()=>gateway.stop());await gateway.start()
  await expect.poll(()=>backends.map(b=>b.startTurn.mock.calls.length)).toEqual([1,1])
  expect(backends[0]!.openSession.mock.calls[0]![0].id).toBe('legacy-session')
  expect(backends[1]!.openSession.mock.calls[0]![0].id).toBeUndefined()
  const approval=backends[0]!.onRequest({kind:'approval',sessionId:'legacy-session',turnId:'turn',payload:{details:{command:'test'}}})
  await expect.poll(()=>imessageSend.mock.calls.at(-1)?.[0]).toContain('/approve')
  const id=imessageSend.mock.calls.at(-1)![0].match(/\/approve ([\w-]+)/)![1]
  batches.push(inbound('w2',`/approve ${id}`))
  await expect.poll(()=>weixinSend.mock.calls.some(c=>c[3].includes('does not belong'))).toBe(true)
  expect(gateway.snapshot()[0]!.channels[0]!.pending).toBe(1)
  await gateway.stop();expect(await approval).toEqual({decision:'cancel'})
})
it('requires CSRF for QR binding and persists credentials privately without returning tokens',async()=>{
  const dir=await fixture(),config=appSchema.parse({port:0,stateDir:dir}),file=join(dir,'config.json'),gateway=new Gateway(config,{photon:{}})
  vi.spyOn(WeixinApi.prototype,'begin').mockResolvedValue({qrcode:'secret-qr',url:'https://weixin.qq.com/bind'})
  vi.spyOn(WeixinApi.prototype,'poll').mockResolvedValue({status:'confirmed',bot_token:credential.token,ilink_bot_id:credential.accountId,ilink_user_id:credential.ownerUserId,baseurl:credential.baseUrl})
  const server=await startServer(file,config,{photon:{}},gateway);cleanup.push(()=>server.close());cleanup.push(()=>gateway.stop())
  const state=await(await fetch(server.url+'/api/state')).json()
  expect((await fetch(server.url+'/api/weixin/begin',{method:'POST',body:'{}'})).status).toBe(403)
  const headers={origin:server.url,'content-type':'application/json','x-agent-token':state.csrf}
  expect((await fetch(server.url+'/api/weixin/begin',{method:'POST',headers,body:'{}'})).status).toBe(200)
  await expect.poll(async()=> (await(await fetch(server.url+'/api/state')).json()).weixinLogin.phase).toBe('connected')
  const exposed=await(await fetch(server.url+'/api/state')).text();expect(exposed).not.toContain(credential.token);expect(exposed).not.toContain('secret-qr')
  const saved=JSON.parse(await readFile(file+'.secrets.json','utf8'));expect(saved.weixin[credential.accountId]).toEqual(credential)
  expect((await stat(file+'.secrets.json')).mode & 0o777).toBe(0o600)
  const route={id:'wechat',cwd:dir,backend:'codex',enabled:false,channels:[{kind:'weixin',id:'wx',accountId:credential.accountId}]}
  expect((await fetch(server.url+'/api/save-route',{method:'POST',headers,body:JSON.stringify({revision:0,id:'wechat',route})})).status).toBe(200)
})

it('preserves large numeric iLink message IDs without rounding',async()=>{
  const api=new WeixinApi((async()=>new Response('{"ret":0,"msgs":[{"message_id":9007199254740993123}]}')) as typeof fetch)
  const response=await api.updates(credential,'',new AbortController().signal)
  expect((response.msgs as Array<{message_id:string}>)[0]!.message_id).toBe('9007199254740993123')
})

it('stops promptly while agent admission is still pending',async()=>{
  const api=new WeixinApi();vi.spyOn(api,'updates').mockResolvedValue({msgs:[inbound('id','task')]})
  let release!:()=>void
  const receive=vi.fn(()=>new Promise<void>(r=>{release=r}))
  const adapter=new WeixinAdapter(credential,{state:{seen:[]},save:async()=>{}},receive,()=>{},api)
  cleanup.push(async()=>{release?.();await adapter.stop()})
  await adapter.start();await expect.poll(()=>receive.mock.calls.length).toBe(1)
  await adapter.stop();expect(adapter.state.phase).toBe('stopped');release()
})
it('does not discard a pairing code submitted while a login poll is in flight',async()=>{
  const api=new WeixinApi(),save=vi.fn(async()=>{})
  vi.spyOn(api,'begin').mockResolvedValue({qrcode:'qr',url:'https://weixin.qq.com/bind'})
  let release!:()=>void
  const poll=vi.spyOn(api,'poll').mockResolvedValueOnce({status:'need_verifycode'}).mockImplementationOnce(async()=>{
    await new Promise<void>(r=>{release=r});return {status:'need_verifycode'}
  }).mockImplementation(async(_qr,_base,code)=>{
    expect(code).toBe('123456')
    return {status:'confirmed',bot_token:credential.token,ilink_bot_id:credential.accountId,ilink_user_id:credential.ownerUserId}
  })
  const login=new WeixinLogin(save,api);cleanup.push(()=>login.cancel());await login.begin()
  await expect.poll(()=>poll.mock.calls.length,{timeout:3000}).toBe(2)
  login.verify(login.snapshot().id!,'123456');release()
  await expect.poll(()=>login.snapshot().phase,{timeout:3000}).toBe('connected')
})

it('uploads encrypted files only to the pinned CDN and sends the returned media reference',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[]
  const api=new WeixinApi((async(url,init)=>{
    calls.push({url:String(url),init:init!})
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'upload-token'})
    if (String(url).includes('/c2c/upload')) return new Response('',{headers:{'x-encrypted-param':'download-token'}})
    return Response.json({ret:0})
  }) as typeof fetch)
  await api.file(credential,credential.ownerUserId,'ctx',{bytes:Buffer.from('hello'),name:'result.txt',mimeType:'text/plain'},new AbortController().signal)
  expect(calls).toHaveLength(3)
  expect(calls[1]!.url).toMatch(/^https:\/\/novac2c.cdn.weixin.qq.com\/c2c\/upload/)
  expect(calls[1]!.init.redirect).toBe('error')
  expect(Buffer.from(calls[1]!.init.body as Uint8Array).toString()).not.toBe('hello')
  expect(JSON.parse(String(calls[2]!.init.body)).msg).toMatchObject({context_token:'ctx',item_list:[{type:4,file_item:{file_name:'result.txt',len:'5',media:{encrypt_query_param:'download-token'}}}]})
  const malicious=new WeixinApi((async()=>Response.json({upload_full_url:'https://attacker.test/upload'})) as typeof fetch)
  await expect(malicious.file(credential,credential.ownerUserId,'ctx',{bytes:Buffer.from('hello'),name:'result.txt',mimeType:'text/plain'},new AbortController().signal)).rejects.toMatchObject({code:'url'})
})

it('bounds emoji replies without breaking grapheme clusters',()=>{
  const family='👨‍👩‍👧‍👦',text=family.repeat(400),parts=splitWeixinText(text)
  expect(parts.every(part=>part.length<=1800 && part.length%family.length===0)).toBe(true)
  expect(parts.join('')).toBe(text)
})

import {expect,it,vi} from 'vitest'
import {appSchema} from '../src/app/config.js'
import {TelegramApi} from '../src/channels/telegram-api.js'
import {telegramAccounts,updateTelegram} from '../src/app/telegram.js'
import {photonAccounts,publicPhotonAccounts} from '../src/app/channel-accounts.js'
const config=appSchema.parse({routes:[{id:'one',cwd:'/tmp',enabled:false,channels:[]},{id:'two',cwd:'/tmp',enabled:false,channels:[]}]})
const secrets={photon:{}}
function api() {const value=new TelegramApi();vi.spyOn(value,'request').mockResolvedValue({id:123,is_bot:true,username:'test_bot'});return value}
it('adds a verified account without binding an Agent and rejects cross-page binding',async()=>{
 const next=await updateTelegram(config,secrets,{token:'123:secret',ownerUserId:'456'},api())
 expect(next.config).toEqual(config)
 expect(telegramAccounts(next.config,next.secrets)[0]).toMatchObject({botId:'123',username:'test_bot',routeId:''})
 expect(JSON.stringify(telegramAccounts(next.config,next.secrets))).not.toContain('secret')
 await expect(updateTelegram(config,secrets,{token:'123:secret',ownerUserId:'456',routeId:'one'},api())).rejects.toThrow('Agent')
})
it('credential changes preserve binding and update the owner without losing schedules',async()=>{
 const legacy=appSchema.parse({routes:[{id:'one',cwd:'/tmp',channels:[{id:'tg',kind:'telegram',botId:'123',ownerUserId:'456'}]}]})
 const next=await updateTelegram(legacy,{photon:{},telegram:{'123':'123:secret'}},{botId:'123',ownerUserId:'789'})
 expect(next.config.routes[0]!.channels?.[0]).toMatchObject({id:'tg',botId:'123',ownerUserId:'789'})
 expect(next.secrets.telegram?.['123']).toBe('123:secret')
 await expect(updateTelegram(config,secrets,{botId:'999',token:'123:secret',ownerUserId:'456'},api())).rejects.toThrow()
})
it('retains legacy Photon credentials for reassignment while excluding secrets from public accounts',()=>{
 const legacy=appSchema.parse({routes:[{id:'one',cwd:'/tmp',projectId:'p',projectSecretEnv:'TEST_PHOTON',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}]})
 const registered=photonAccounts(legacy,{photon:{one:'private-photon'}})
 expect(registered.p?.secret).toBe('private-photon')
 expect(publicPhotonAccounts(config,{photon:{},photonAccounts:registered})).toEqual([{projectId:'p',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}])
 expect(JSON.stringify(publicPhotonAccounts(legacy,{photon:{one:'private-photon'}}))).not.toContain('private-photon')
})
it('manages bots through revision-protected HTTP endpoints without exposing tokens',async()=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path')
 const {Gateway}=await import('../src/gateway/app.js');const {startServer}=await import('../src/app/server.js')
 const dir=await mkdtemp(join(tmpdir(),'telegram-management-'))
 const initial=appSchema.parse({...config,port:0,stateDir:dir}),gateway=new Gateway(initial,secrets)
 const server=await startServer(join(dir,'config.json'),initial,secrets,gateway)
 const spy=vi.spyOn(TelegramApi.prototype,'request').mockResolvedValue({id:123,is_bot:true,username:'test_bot'})
 try {
  const state=await(await fetch(server.url+'/api/state')).json()
  const post=(path:string,body:unknown)=>fetch(server.url+path,{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify(body)})
  expect((await fetch(server.url+'/api/telegram/save',{method:'POST',body:'{}'})).status).toBe(403)
  expect((await post('/api/telegram/save',{revision:99,token:'123:secret',ownerUserId:'456'})).status).toBe(409)
  expect(spy).not.toHaveBeenCalled()
  expect((await post('/api/telegram/save',{revision:0,token:'123:secret',ownerUserId:'456'})).status).toBe(200)
  expect((await post('/api/telegram/bind',{revision:1,botId:'123',routeId:'two'})).status).toBe(404)
  const route={...initial.routes[1],channels:[{id:'tg',kind:'telegram',botId:'123',ownerUserId:'456'}]}
  expect((await post('/api/save-route',{revision:1,id:'two',route})).status).toBe(200)
  const exposed=await(await fetch(server.url+'/api/state')).text()
  expect(exposed).not.toContain('123:secret')
  expect(JSON.parse(exposed).telegramAccounts[0]).toMatchObject({botId:'123',routeId:'two',ownerUserId:'456'})
  expect(JSON.parse(await readFile(join(dir,'config.json.secrets.json'),'utf8')).telegram['123']).toBe('123:secret')
  const {PhotonAccount}=await import('../src/app/photon.js')
  const photon=vi.spyOn(PhotonAccount.prototype,'select').mockResolvedValue({projectId:'p',secret:'photon-private',assignedPhoneNumber:'+15557654321'})
  try {
   expect((await post('/api/photon/account',{revision:2,projectId:'p',name:'Prepared',sender:'+15551234567'})).status).toBe(200)
   const imessage={id:'imessage',kind:'imessage',projectId:'p',projectSecretEnv:'AGENT_PHOTON_MANAGED',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
   expect((await post('/api/save-route',{revision:3,id:'one',route:{...initial.routes[0],channels:[imessage]}})).status).toBe(200)
   expect((await post('/api/save-route',{revision:4,id:'one',route:initial.routes[0]})).status).toBe(200)
   expect((await post('/api/save-route',{revision:5,id:'two',route:{...route,channels:[...route.channels,imessage]}})).status).toBe(200)
   const saved=JSON.parse(await readFile(join(dir,'config.json.secrets.json'),'utf8'))
   expect(saved.photon['two:imessage']).toBe('photon-private')
   expect(saved.photonAccounts.p.secret).toBe('photon-private')
   const publicState=await(await fetch(server.url+'/api/state')).text()
   expect(publicState).not.toContain('photon-private')
   expect(JSON.parse(publicState).photonAccounts).toHaveLength(1)
  } finally {photon.mockRestore()}

 } finally {spy.mockRestore();await server.close();await gateway.stop();await rm(dir,{recursive:true,force:true})}
})

it('reports owner and provider validation failures without leaking the token',async()=>{
 const value=api()
 await expect(updateTelegram(config,secrets,{token:'123:secret',ownerUserId:'ShoWin2333'},value)).rejects.toThrow('纯数字')
 expect(value.request).not.toHaveBeenCalled()
 const {TelegramError}=await import('../src/channels/telegram-api.js')
 for (const [code,expected] of [[401,'Token 无效'],[404,'Token 无效'],[429,'过于频繁'],[0,'无法连接']] as const) {
  vi.mocked(value.request).mockRejectedValueOnce(new TelegramError(code))
  await expect(updateTelegram(config,secrets,{token:'123:secret',ownerUserId:'456'},value)).rejects.toThrow(expected)
 }
})

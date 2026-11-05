import {afterEach,expect,it,vi} from 'vitest'
import {FeishuAdapter,splitFeishuText,type FeishuScope} from '../src/channels/feishu.js'
import type {FeishuCallbacks,FeishuConnection,FeishuEvent} from '../src/channels/feishu-api.js'
import type {ChannelMessage} from '../src/channels/types.js'
import type {RouteState} from '../src/channels/state.js'
import {pluginConfigSchema} from '../src/plugin/config.js'
import {Config} from '../src/plugin/schema.js'
import {bindingIssues} from '../src/shared/rules.js'
import {bindingKey} from '../src/plugin/identity.js'
import {ChannelInteractions} from '../src/plugin/interactions.js'

const scope:FeishuScope={id:'owner-feishu',kind:'feishu',appId:'cli_1234567890abcdef',tenantKey:'tenant_synthetic',ownerUserId:'ou_owner',chatId:'oc_private'}
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn();vi.restoreAllMocks();vi.useRealTimers()})
const event=(patch:Partial<FeishuEvent>={}):FeishuEvent=>({app_id:scope.appId,tenant_key:scope.tenantKey,
  sender:{tenant_key:scope.tenantKey,sender_type:'user',sender_id:{open_id:scope.ownerUserId}},
  message:{message_id:'om_one',chat_id:scope.chatId,chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'hello'}),create_time:'1700000000000'},...patch})
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
async function fixture(options:{store?:{state:RouteState;save:ReturnType<typeof vi.fn>};handler?:(m:ChannelMessage)=>Promise<void>;autoReady?:boolean}={}){
  const store=options.store??{state:{seen:[]},save:vi.fn(async()=>{})}
  const clients:Array<FeishuConnection & {callbacks:FeishuCallbacks}>=[]
  const onMessage=vi.fn(options.handler??(async(_message:ChannelMessage)=>{})),states=vi.fn()
  const createClient=vi.fn((_app:string,_secret:string,_owner:string,_signal:AbortSignal,callbacks:FeishuCallbacks)=>{
    const client={callbacks,start:vi.fn(async()=>{if(options.autoReady!==false) callbacks.ready()}),close:vi.fn(),send:vi.fn(async()=>{}),upload:vi.fn(async()=>{})}
    clients.push(client);return client
  })
  const value=new FeishuAdapter(scope,'synthetic-secret',store,onMessage,states,createClient)
  cleanup.push(()=>value.stop());await value.start()
  return {value,clients,client:clients[0]!,store,onMessage,states,createClient}
}

it('validates host and native config, duplicate app consumers and identity rotation',()=>{
  const binding={id:scope.id,cwd:'/tmp',credentialRef:'FEISHU_SECRET',permissionPreset:'workspace-write',channel:scope}
  const parsed=pluginConfigSchema.parse({bindings:[binding]}).bindings[0]!
  expect(parsed.enabled).toBe(false);expect(bindingIssues([parsed])).toEqual([])
  expect(Config({bindings:[parsed]}).bindings.get()[0].channel).toEqual(scope)
  for(const patch of [{appId:'cli_bad'},{ownerUserId:'user_id'},{chatId:'group'},{tenantKey:''},{domain:'https://evil.example'},{appSecret:'must-not-be-config'}]) {
    expect(()=>pluginConfigSchema.parse({bindings:[{...binding,channel:{...scope,...patch}}]})).toThrow()
  }
  for(const patch of [{appId:'bad'},{ownerUserId:'user_id'},{chatId:'bad'},{tenantKey:'bad key'}]) expect(bindingIssues([{...parsed,channel:{...scope,...patch}}]).length).toBeGreaterThan(0)
  expect(()=>pluginConfigSchema.parse({bindings:[parsed,{...parsed,id:'two',channel:{...scope,id:'two',ownerUserId:'ou_other'}}]})).toThrow('account-duplicate')
  expect(bindingKey(parsed)).toBe(bindingKey({...parsed,credentialRef:'ROTATED',enabled:true}))
  for(const patch of [{tenantKey:'other'},{ownerUserId:'ou_other'},{chatId:'oc_other'},{appId:'cli_fedcba0987654321'}]) expect(bindingKey({...parsed,channel:{...scope,...patch}})).not.toBe(bindingKey(parsed))
})
it('accepts only exact app, tenant, owner and private chat text',async()=>{
  const {client,onMessage,createClient}=await fixture()
  expect(createClient).toHaveBeenCalledWith(scope.appId,'synthetic-secret',scope.ownerUserId,expect.any(AbortSignal),expect.any(Object))
  const raw=event()
  const invalid:Partial<FeishuEvent>[]=[{app_id:'other'},{app_id:undefined},{tenant_key:'other'},
    {sender:{...raw.sender,tenant_key:'other'}},{sender:{...raw.sender,sender_type:'app'}},{sender:{...raw.sender,sender_id:{open_id:'ou_other'}}},
    ...[{chat_type:'group'},{chat_id:'oc_other'},{message_type:'image'},{message_id:''},{content:'not json'},{content:'null'},
      {content:JSON.stringify({text:3})},{content:JSON.stringify({text:'   '})},{content:'x'.repeat(65537)}].map(patch=>({message:{...raw.message,...patch}}))]
  for(const input of invalid) await client.callbacks.message(event(input))
  expect(onMessage).not.toHaveBeenCalled()
  await client.callbacks.message(raw)
  expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:`feishu:${scope.appId}:${scope.chatId}:om_one`,text:'hello',nativeVoice:false}))
})
it('deduplicates concurrent events and persists accepted message IDs across restart',async()=>{
  const gate=deferred(),f=await fixture({handler:()=>gate.promise})
  const first=f.client.callbacks.message(event()),duplicate=f.client.callbacks.message(event({event_id:'different-envelope'}))
  expect(first).toBe(duplicate);await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(1))
  expect(f.store.save).not.toHaveBeenCalled();gate.resolve();await first
  expect(f.store.state.seen).toEqual([`feishu:${scope.appId}:${scope.chatId}:om_one`])
  const restarted=await fixture({store:f.store});await restarted.client.callbacks.message(event())
  expect(restarted.onMessage).not.toHaveBeenCalled()
})
it('rejects failed admission and checkpoint writes so provider replay can retry',async()=>{
  const handler=vi.fn(async()=>{}).mockRejectedValueOnce(new Error('secret must not leak'))
  const f=await fixture({handler})
  await expect(f.client.callbacks.message(event())).rejects.toThrow('could not be confirmed')
  expect(f.store.state.seen).toEqual([])
  f.store.save.mockRejectedValueOnce(new Error('private disk error'))
  await expect(f.client.callbacks.message(event())).rejects.toThrow('could not be confirmed')
  expect(f.store.state.seen).toEqual([])
  await f.client.callbacks.message(event());expect(f.onMessage).toHaveBeenCalledTimes(3)
  await f.client.callbacks.message(event());expect(f.onMessage).toHaveBeenCalledTimes(3)
})
it('serializes bounded admission and rejects overflow without acknowledging dropped work',async()=>{
  const gate=deferred(),f=await fixture({handler:()=>gate.promise}),work:Promise<void>[]=[]
  for(let i=0;i<32;i++)work.push(f.client.callbacks.message(event({message:{...event().message,message_id:`om_${i}`}})))
  await expect(f.client.callbacks.message(event({message:{...event().message,message_id:'om_overflow'}}))).rejects.toThrow('temporarily unavailable')
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(1));gate.resolve();await Promise.all(work)
  expect(f.onMessage).toHaveBeenCalledTimes(32)
  await f.client.callbacks.message(event({message:{...event().message,message_id:'om_overflow'}}));expect(f.onMessage).toHaveBeenCalledTimes(33)
})
it('bounds durable dedupe history and handles malformed sender/message payloads',async()=>{
  const store={state:{seen:Array.from({length:1024},(_,i)=>`old-${i}`)},save:vi.fn(async()=>{})},f=await fixture({store})
  await f.client.callbacks.message(event());expect(store.state.seen).toHaveLength(1024);expect(store.state.seen).not.toContain('old-0')
  for(const patch of [{sender:null},{message:null}] as unknown as Partial<FeishuEvent>[]) await f.client.callbacks.message(event(patch))
  expect(f.onMessage).toHaveBeenCalledTimes(1)
})
it('tracks readiness, disconnect, reconnect and terminal failure; suppresses stale callbacks',async()=>{
  const f=await fixture({autoReady:false});expect(f.value.state.phase).toBe('starting')
  await expect(f.value.approvalMessage()).rejects.toThrow('not connected')
  f.client.callbacks.ready();const message=await f.value.scheduledMessage('one','')
  f.client.callbacks.reconnecting();expect(f.value.state.phase).toBe('retrying');await expect(message.send('offline')).rejects.toThrow('connection changed')
  f.client.callbacks.ready();await message.send('reconnected');expect(f.client.send).toHaveBeenCalledTimes(1)
  f.client.callbacks.failed();expect(f.value.state.phase).toBe('failed');await expect(message.send('failed')).rejects.toThrow()
  expect(JSON.stringify(f.value.state)).not.toContain('synthetic-secret')
  const closing=f.value.stop();expect(f.value.stop()).toBe(closing);await closing
  f.client.callbacks.ready();expect(f.value.state.phase).toBe('stopped')
  await expect(f.client.callbacks.message(event())).rejects.toThrow('changed')
  await f.value.start();expect(f.clients).toHaveLength(2);f.clients[1]!.callbacks.ready();f.client.callbacks.failed()
  expect(f.value.state.phase).toBe('listening')
})
it('does not mistake the SDK start return for a handshake; times out and closes safely',async()=>{
  vi.useFakeTimers();const f=await fixture({autoReady:false})
  expect(f.value.state.phase).toBe('starting');await vi.advanceTimersByTimeAsync(60000)
  expect(f.value.state.phase).toBe('failed');expect(f.client.close).toHaveBeenCalledOnce()
  f.client.callbacks.ready();expect(f.value.state.phase).toBe('failed')
})
it('stopping fences queued admission and delivery without waiting on a blocked host',async()=>{
  const gate=deferred(),f=await fixture({handler:()=>gate.promise}),message=await f.value.approvalMessage()
  const first=f.client.callbacks.message(event()),second=f.client.callbacks.message(event({message:{...event().message,message_id:'om_two'}}))
  const settled=Promise.allSettled([first,second]);await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledOnce())
  await f.value.stop();await expect(message.send('stale')).rejects.toThrow();gate.resolve()
  expect((await settled).every(r=>r.status==='rejected')).toBe(true);expect(f.onMessage).toHaveBeenCalledOnce();expect(f.store.save).not.toHaveBeenCalled()
})
it('sends lossless UTF-8 chunks, bounded media and text approval with terminal status',async()=>{
  const f=await fixture(),message=await f.value.approvalMessage(),text='中'.repeat(5000)+'👨‍👩‍👧‍👦'
  await message.send(text);expect(f.client.send.mock.calls.map(([part])=>part).join('')).toBe(text)
  expect(f.client.send.mock.calls.every(([part])=>Buffer.byteLength(part)<=12000)).toBe(true)
  const payload={bytes:Buffer.from('file'),name:'result.txt',mimeType:'text/plain'},cancelled=new AbortController();cancelled.abort()
  await expect(message.sendFile(payload,cancelled.signal)).rejects.toThrow();expect(f.client.upload).not.toHaveBeenCalled()
  await message.sendFile(payload);await message.sendImage!({...payload,name:'image.png',mimeType:'image/png'})
  expect(f.client.upload.mock.calls.map(([,image])=>image)).toEqual([false,true])
  await expect(message.sendImage!({...payload,bytes:Buffer.alloc(10*1024*1024+1)})).rejects.toThrow('size limit')
  await expect(message.sendFile({...payload,bytes:Buffer.alloc(20*1024*1024+1)})).rejects.toThrow('size limit')
  await expect(message.sendVoice(payload)).rejects.toThrow('file delivery')
  const token='a-12345678-abcd-4123-9123-123456789abc',finish=await message.sendApproval!('Review action',token,new AbortController().signal)
  expect(f.client.send.mock.calls.at(-1)?.[0]).toContain(`/approve ${token}`)
  await finish?.('expired');expect(f.client.send.mock.calls.at(-1)?.[0]).toContain('渠道审批已过期')
})
it('approval grants only a matching, delivered owner reply and expires on disconnection',async()=>{
  let interactions!:ChannelInteractions
  const replies:string[]=[],f=await fixture({handler:async m=>{replies.push(interactions.reply(m.text))}})
  interactions=new ChannelInteractions(()=>f.value.state.phase==='listening',1000)
  const scope={sessionId:'s',turn:1,toolName:'test',callId:'call',signal:new AbortController().signal,current:()=>true,reason:'Review this action'}
  const outcome=interactions.approval(scope,await f.value.approvalMessage())
  await vi.waitFor(()=>expect(f.client.send).toHaveBeenCalledOnce())
  const token=/\/approve (a-[0-9a-f-]+)/.exec(f.client.send.mock.calls[0]![0])![1]!
  const message={...event().message,content:JSON.stringify({text:`/approve ${token}`})}
  await f.client.callbacks.message(event({sender:{...event().sender,sender_id:{open_id:'ou_attacker'}},message}))
  expect(replies).toEqual([])
  await f.client.callbacks.message(event({message}));expect(await outcome).toBe('allowed-once')
  expect(()=>interactions.reply(`/approve ${token}`)).toThrow('失效')
  const disconnected=interactions.approval({...scope,callId:'two'},await f.value.approvalMessage())
  await vi.waitFor(()=>expect(f.client.send).toHaveBeenCalledTimes(2));f.client.callbacks.reconnecting();interactions.cancel()
  expect(await disconnected).toBe('cancelled')
})
it('splits graphemes by UTF-8 size and rejects oversized combining sequences',()=>{
  const text='😀'.repeat(3001)+'a';expect(splitFeishuText(text).join('')).toBe(text)
  expect(splitFeishuText('')).toEqual([]);expect(()=>splitFeishuText('a'+'\u0301'.repeat(7000))).toThrow('oversized')
})

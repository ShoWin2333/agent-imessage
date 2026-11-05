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
import {ChannelBridge,type BindingState,type NativeSession} from '../src/plugin/bridge.js'

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
it('bounds concurrent admission and reserves capacity for control messages',async()=>{
  const gate=deferred(),f=await fixture({handler:()=>gate.promise}),work:Promise<void>[]=[]
  for(let i=0;i<32;i++)work.push(f.client.callbacks.message(event({message:{...event().message,message_id:`om_${i}`}})))
  await expect(f.client.callbacks.message(event({message:{...event().message,message_id:'om_overflow'}}))).rejects.toThrow('temporarily unavailable')
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(32))
  const control=f.client.callbacks.message(event({message:{...event().message,message_id:'om_cancel',content:JSON.stringify({text:'/cancel'})}}))
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(33))
  gate.resolve();await Promise.all([...work,control])
  expect(f.onMessage).toHaveBeenCalledTimes(33)
  await f.client.callbacks.message(event({message:{...event().message,message_id:'om_overflow'}}));expect(f.onMessage).toHaveBeenCalledTimes(34)
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
it('stopping fences pending checkpoints and delivery without waiting on a blocked host',async()=>{
  const gate=deferred(),f=await fixture({handler:()=>gate.promise}),message=await f.value.approvalMessage()
  const first=f.client.callbacks.message(event()),second=f.client.callbacks.message(event({message:{...event().message,message_id:'om_two'}}))
  const settled=Promise.allSettled([first,second]);await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(2))
  await f.value.stop();await expect(message.send('stale')).rejects.toThrow();gate.resolve()
  expect((await settled).every(r=>r.status==='rejected')).toBe(true);expect(f.onMessage).toHaveBeenCalledTimes(2);expect(f.store.save).not.toHaveBeenCalled()
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

const input=(id:string,text:string)=>event({message:{...event().message,message_id:`om_${id}`,content:JSON.stringify({text})}})
async function composed(options:{opening?:Promise<void>;admitted?:Promise<void>}={}){
  let state:BindingState={receipts:[]}
  const submit=vi.fn<NativeSession['submit']>(()=>({admitted:options.admitted??Promise.resolve(),result:Promise.resolve({text:'done',reason:'completed'})}))
  const session:NativeSession={id:'feishu-synthetic-session',submit,cancel:vi.fn(),close:vi.fn(async()=>{})}
  const host={open:vi.fn(async()=>{await options.opening;return session}),inspect:vi.fn(async()=>undefined)}
  const bridge=new ChannelBridge(host,{read:()=>structuredClone(state),write:async next=>{state=structuredClone(next)}})
  const f=await fixture({handler:message=>bridge.receive(message)})
  cleanup.push(()=>bridge.close())
  return {...f,bridge,host,session,submit,read:()=>state}
}
it.each(['/cancel','/stop'])('%s reaches Bridge during slow initialization and prevents task submission',async command=>{
  const gate=deferred(),f=await composed({opening:gate.promise})
  const task=f.client.callbacks.message(input('slow','task'))
  await vi.waitFor(()=>expect(f.host.open).toHaveBeenCalledOnce())
  const control=f.client.callbacks.message(input('cancel',command))
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(2))
  // Both calls reached the real Bridge before host.open can resolve.
  gate.resolve();await Promise.all([task,control]);await f.bridge.drain()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.read().receipts.find(r=>r.id.endsWith(':om_slow'))?.result).toEqual({text:'已取消。',reason:'interrupted'})
  expect(f.store.state.seen).toHaveLength(2)
})
it('full ordinary capacity still admits a deduplicated cancel and cancels every queued Bridge input',async()=>{
  const gate=deferred(),f=await composed({opening:gate.promise}),tasks:Promise<void>[]=[]
  for(let i=0;i<32;i++) tasks.push(f.client.callbacks.message(input(`queued_${i}`,`task ${i}`)))
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(32))
  await expect(f.client.callbacks.message(input('overflow','too many'))).rejects.toThrow('temporarily unavailable')
  const control=f.client.callbacks.message(input('cancel','/cancel'))
  expect(f.client.callbacks.message(input('cancel','/cancel'))).toBe(control)
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(33))
  gate.resolve();await Promise.all([...tasks,control]);await f.bridge.drain()
  expect(f.submit).not.toHaveBeenCalled()
  expect(f.read().receipts).toHaveLength(33)
  expect(f.store.state.seen).toHaveLength(33)
  expect(new Set(f.store.state.seen).size).toBe(33)
  // A fresh task after cancellation remains usable; replay cannot cancel it.
  f.submit.mockReturnValueOnce({admitted:Promise.resolve(),result:Promise.resolve({text:'fresh',reason:'completed'})})
  await f.client.callbacks.message(input('fresh','new task'));await f.bridge.drain()
  const cancellations=vi.mocked(f.session.cancel).mock.calls.length
  await f.client.callbacks.message(input('cancel','/cancel'))
  expect(f.submit).toHaveBeenCalledOnce();expect(f.submit.mock.calls[0]?.[1]).toBe('new task')
  expect(f.session.cancel).toHaveBeenCalledTimes(cancellations)
})
it('cancels an existing session before its slow admission promise settles',async()=>{
  const gate=deferred(),f=await composed({admitted:gate.promise})
  const task=f.client.callbacks.message(input('task','task'))
  await vi.waitFor(()=>expect(f.submit).toHaveBeenCalledOnce())
  const control=f.client.callbacks.message(input('cancel','/cancel'))
  await vi.waitFor(()=>expect(f.session.cancel).toHaveBeenCalled())
  gate.resolve();await Promise.all([task,control]);await f.bridge.drain()
})
it('keeps concurrent transport checkpoints serialized and duplicate acknowledgements durable',async()=>{
  const gate=deferred(),saved:string[][]=[]
  const store={state:{seen:[] as string[]},save:vi.fn(async()=>{
    if(store.save.mock.calls.length===1){await gate.promise;throw new Error('disk failure')}
    saved.push([...store.state.seen])
  })}
  const f=await fixture({store})
  const first=f.client.callbacks.message(input('first','task'))
  const failed=expect(first).rejects.toThrow('could not be confirmed')
  await vi.waitFor(()=>expect(store.save).toHaveBeenCalledOnce())
  expect(f.client.callbacks.message(input('first','task'))).toBe(first)
  const control=f.client.callbacks.message(input('control','/status'))
  await vi.waitFor(()=>expect(f.onMessage).toHaveBeenCalledTimes(2))
  expect(store.save).toHaveBeenCalledOnce()
  gate.resolve();await failed;await control
  expect(saved).toEqual([[`feishu:${scope.appId}:${scope.chatId}:om_control`]])
  await f.client.callbacks.message(input('first','task'))
  expect(store.state.seen).toEqual([`feishu:${scope.appId}:${scope.chatId}:om_control`,`feishu:${scope.appId}:${scope.chatId}:om_first`])
})
it('does not replay a persisted Bridge cancellation after a transport checkpoint failure',async()=>{
  const f=await composed()
  await f.client.callbacks.message(input('first','task'));await f.bridge.drain()
  f.store.save.mockRejectedValueOnce(new Error('disk failure'))
  await expect(f.client.callbacks.message(input('cancel','/cancel'))).rejects.toThrow('could not be confirmed')
  const cancellations=vi.mocked(f.session.cancel).mock.calls.length
  await f.client.callbacks.message(input('fresh','fresh task'));await f.bridge.drain()
  await f.client.callbacks.message(input('cancel','/cancel'))
  expect(f.session.cancel).toHaveBeenCalledTimes(cancellations)
  expect(f.submit).toHaveBeenCalledTimes(2)
})

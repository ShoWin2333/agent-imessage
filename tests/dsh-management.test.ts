import { expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {volatileForm,plainConfig,projectForm} from '../node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js'
import { Config } from '../src/plugin/schema.js'
import { ChannelManager, ChannelsController, ActivationCleanupError } from '../src/plugin/management.js'
import { bindingKey, pluginConfigSchema, apply } from '../src/plugin/index.js'
import { legacyCheckpoint, wasLegacyMessage } from '../src/plugin/legacy-checkpoint.js'
import type { Context } from '@deepseek-ai/cordis'
const binding = (id = 'a', enabled = true) => pluginConfigSchema.parse({ bindings: [{ id, enabled, cwd:'/tmp', channel:{id,kind:'telegram',botId:id === 'a' ? '123' : '789',ownerUserId:'456'}, credentialRef:'SYNTHETIC_TOKEN',permissionPreset:'workspace-write' }] }).bindings[0]!
function deferred<T>() { let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve} }
it('buffers the latest status change while the consumer is paused at a yield and releases on abort',async()=>{
  const manager=new ChannelManager(async()=>({close:async()=>{}})),abort=new AbortController()
  const subscribe=vi.spyOn(manager,'subscribe'),release=vi.fn()
  subscribe.mockImplementation(listener=>{const dispose=ChannelManager.prototype.subscribe.call(manager,listener);return()=>{release();dispose()}})
  const stream=ChannelsController.prototype.statusStream.call({manager} as unknown as ChannelsController,abort.signal)[Symbol.asyncIterator]()
  let pending:Promise<IteratorResult<unknown>>|undefined
  try {
    expect((await stream.next()).value).toEqual({bindings:[]})
    manager.rejectConfiguration()
    manager.rejectConfiguration()
    let delivered=false
    pending=stream.next().then(value=>{delivered=true;return value})
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(delivered).toBe(true)
    expect((await pending).value).toEqual({bindings:[],configError:'config-invalid'})
    pending=stream.next()
    abort.abort()
    expect((await pending).done).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
  } finally {abort.abort();await pending;await stream.return?.();await manager.close()}
})
it('unsubscribes immediately when aborted while paused at a yielded status',async()=>{
  const release=vi.fn(),abort=new AbortController()
  const manager={status:()=>({bindings:[]}),subscribe:()=>release}
  const stream=ChannelsController.prototype.statusStream.call({manager} as unknown as ChannelsController,abort.signal)[Symbol.asyncIterator]()
  await stream.next()
  abort.abort()
  expect(release).toHaveBeenCalledTimes(1)
  expect((await stream.next()).done).toBe(true)
  expect(release).toHaveBeenCalledTimes(1)
})
it('native schema and browser JSON rehydration accept omitted optional objects and default to stopped',()=>{
  const b=binding();const {enabled:_,...raw}=b
  for(const schema of [Config,new Schema(JSON.parse(JSON.stringify(Config)))]){
    const value=schema({bindings:[raw]}).bindings.get()[0]
    expect(value.enabled).toBe(false);expect(value.model).toBeUndefined();expect(value.weixin).toBeUndefined()
    expect(()=>schema({bindings:[{...raw,channel:{...raw.channel,ownerUserId:'not-an-id'}}]})).toThrow()
    expect(()=>pluginConfigSchema.parse({bindings:[raw,{...raw,id:'two'}]})).toThrow()
    expect(()=>pluginConfigSchema.parse({bindings:[{...raw,token:'must-not-be-accepted'}]})).toThrow()
  }
})
it('survives the actual native Settings schema projection and second wire serialization',()=>{
  const form=volatileForm(Config)!
  const browser=new Schema(JSON.parse(JSON.stringify(form)))
  expect(browser(projectForm(form,plainConfig(Config({}))))).toEqual({bindings:[],agents:[]})
  const b=binding('a',false)
  expect(browser({bindings:[b]}).bindings).toEqual([b])
})
it('enabled is activation state, while a model change partitions durable binding identity',()=>{
  const direct = { ...binding(), directTelegramVoice: true }
  expect(pluginConfigSchema.parse({ bindings: [direct] }).bindings[0]).toEqual(binding())
  expect(Config({ bindings: [direct] }).bindings.get()[0].directTelegramVoice).toBe(true)
  expect(bindingKey(pluginConfigSchema.parse({ bindings: [direct] }).bindings[0]!)).toBe(bindingKey(binding()))
  const b=binding();expect(bindingKey(b)).toBe(bindingKey({...b,enabled:false}))
  expect(bindingKey(b)).not.toBe(bindingKey({...b,model:{provider:'synthetic',model:'other'}}))
  // Rotating a secret must keep the same channel session and receipts.
  expect(bindingKey(b)).toBe(bindingKey({...b,credentialRef:'ROTATED_SECRET'}))
})
it('notifies subscribers on each accepted lifecycle transition',async()=>{
  const start=vi.fn(async(_binding:ReturnType<typeof binding>,_signal:AbortSignal,state:(phase:string)=>void)=>{state('listening');return{close:vi.fn(async()=>{})}})
  const manager=new ChannelManager(start),listener=vi.fn(),release=manager.subscribe(listener)
  await manager.update([binding()])
  expect(listener).toHaveBeenCalled()
  release();await manager.close()
})
it('disabled binding cannot read credentials or start channels even when the directory is absent',async()=>{
  let close!:()=>Promise<void>;const secret=vi.fn(),domainClose=vi.fn(async()=>{})
  const logger={warn:vi.fn(),error:vi.fn(),info:vi.fn(),debug:vi.fn()}
  const ctx={logger:()=>logger,plugin:vi.fn(),get:()=>undefined,on:vi.fn(),tools:{register:vi.fn(()=>()=>{})},storageDomain:{open:async()=>({close:domainClose})},credentials:{resolve:secret},effect:(fn:()=>()=>Promise<void>)=>{close=fn()}} as unknown as Context
  await apply(ctx,{bindings:[{...binding('a',false),cwd:'/absent-synthetic-directory'}]});expect(secret).not.toHaveBeenCalled();await close();expect(domainClose).toHaveBeenCalled()
})
it('saving another binding preserves unchanged consumers and disabling closes only its owner',async()=>{
  const closes=new Map<string,ReturnType<typeof vi.fn>>(),start=vi.fn(async(b:ReturnType<typeof binding>,_signal:AbortSignal,state:(phase:string)=>void)=>{const close=vi.fn(async()=>{});closes.set(b.id,close);state('listening');return {close}})
  const manager=new ChannelManager(start);await manager.update([binding()]);await manager.update([binding(),binding('b',false)])
  expect(start).toHaveBeenCalledTimes(1);expect(manager.status().bindings).toEqual([{id:'a',phase:'listening'},{id:'b',phase:'stopped'}])
  await manager.update([binding('a',false),binding('b')]);expect(closes.get('a')).toHaveBeenCalledTimes(1);expect(start).toHaveBeenCalledTimes(2);await manager.close()
})
it('a newer stop fences pending startup and every not-yet-started binding from the old list',async()=>{
  const pending=deferred<void>(),starts:string[]=[]
  const manager=new ChannelManager(async(b,signal)=>{starts.push(b.id);await pending.promise;if(signal.aborted)throw new Error('aborted');return {close:async()=>{}}})
  const first=manager.update([binding(),binding('b')]);await vi.waitFor(()=>expect(starts).toEqual(['a']))
  const stop=manager.update([binding('a',false),binding('b',false)]);pending.resolve();await first;await stop
  expect(starts).toEqual(['a']);expect(manager.status().bindings.every(b=>b.phase==='stopped')).toBe(true);await manager.close()
})
it('a returned resource whose cancellation cleanup fails remains owned and prevents duplicate consumers',async()=>{
  const pending=deferred<void>(),close=vi.fn(async()=>{throw new Error('uncertain cleanup')}),start=vi.fn(async()=>{await pending.promise;return {close}})
  const manager=new ChannelManager(start),first=manager.update([binding()]);await vi.waitFor(()=>expect(start).toHaveBeenCalledTimes(1))
  const stop=manager.update([binding('a',false)]);pending.resolve();await expect(first).rejects.toThrow('teardown');await expect(stop).rejects.toThrow('teardown')
  await expect(manager.update([binding()])).rejects.toThrow('teardown');expect(start).toHaveBeenCalledTimes(1);await expect(manager.close()).rejects.toThrow('teardown')
})
it('startup failure with failed factory cleanup also retains a teardown tombstone',async()=>{
  const resource={close:vi.fn(async()=>{throw new Error('uncertain')})},start=vi.fn(async()=>{throw new ActivationCleanupError(resource)})
  const manager=new ChannelManager(start);await expect(manager.update([binding()])).rejects.toThrow('teardown')
  await expect(manager.update([binding()])).rejects.toThrow('teardown');expect(start).toHaveBeenCalledTimes(1);await expect(manager.close()).rejects.toThrow('teardown')
})
it('ordinary activation failure is visible without leaking raw errors or stopping another route',async()=>{
  const close=vi.fn(async()=>{}),manager=new ChannelManager(async(b,_signal,state)=>{if(b.id==='a')throw new Error('SYNTHETIC_SECRET_DO_NOT_DISPLAY');state('listening');return {close}})
  await manager.update([binding(),binding('b')]);expect(manager.status().bindings.find(b=>b.id==='a')?.phase).toBe('error')
  expect(JSON.stringify(manager.status())).not.toContain('SYNTHETIC_SECRET');expect(close).not.toHaveBeenCalled();await manager.close()
})

it('legacy metadata suppresses exact old ids without inventing native receipts or replaying history',()=>{
  const old=legacyCheckpoint({seen:['telegram:42','telegram:42'],channelCursor:'101'},'telegram')
  expect(old).toEqual({seen:['telegram:42'],legacySeen:['telegram:42'],channelCursor:'101'})
  expect(wasLegacyMessage(new Set(old.legacySeen),'telegram:42')).toBe(true)
  expect(wasLegacyMessage(new Set(old.legacySeen),'telegram:43')).toBe(false)
  expect(()=>legacyCheckpoint({seen:[],tasks:[{input:'private history must not be imported'}]},'telegram')).toThrow()
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'101'},'imessage')).toThrow()
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'9007199254740992'},'telegram')).toThrow()
})

it('preserves opaque Weixin buffers exactly and refuses reply contexts or mixed history',()=>{
  for(const cursor of ['', '00001234', 'opaque+/=%\\n游标', '9007199254740993123']) {
    const checkpoint=legacyCheckpoint({seen:['old','old'],channelCursor:cursor},'weixin')
    expect(checkpoint).toEqual({seen:['old'],legacySeen:['old'],channelCursor:cursor})
    expect(JSON.parse(JSON.stringify(checkpoint)).channelCursor).toBe(cursor)
  }
  const privateCursor='SYNTHETIC_PRIVATE_CURSOR'
  for(const value of [{seen:[],channelCursor:privateCursor,weixinContext:'old-reply-context'},{seen:[],channelCursor:privateCursor,tasks:[]},{seen:[],channelCursor:{privateCursor}}]) {
    let error:unknown
    try {legacyCheckpoint(value,'weixin')}catch(e){error=e}
    expect(error).toBeInstanceOf(Error);expect(String(error)).toBe('Error: Invalid legacy channel checkpoint')
  }
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'界'.repeat(350_000)},'weixin')).toThrow('Invalid legacy channel checkpoint')
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'\u0000'.repeat(175_000)},'weixin')).toThrow('Invalid legacy channel checkpoint')
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'opaque'},'telegram')).toThrow()
  expect(()=>legacyCheckpoint({seen:[],channelCursor:'opaque'},'unknown')).toThrow()
})

it('reports rejected external settings without interrupting accepted consumers',async()=>{
  const close=vi.fn(async()=>{}),start=vi.fn(async()=>({close})),manager=new ChannelManager(start)
  await manager.update([binding()]);manager.rejectConfiguration()
  expect(manager.status().configError).toBe('config-invalid');expect(close).not.toHaveBeenCalled();expect(start).toHaveBeenCalledTimes(1)
  await manager.update([binding()]);expect(manager.status().configError).toBeUndefined();expect(start).toHaveBeenCalledTimes(1)
  await manager.close()
})
it.each(['/workspace/project','C:\\workspace\\project','D:/workspace/project','\\\\server\\share\\project'])('accepts portable absolute workspace %s in native/browser/runtime schemas',cwd=>{
 const value={bindings:[{...binding(),cwd}]};expect(pluginConfigSchema.parse(value).bindings[0]!.cwd).toBe(cwd)
 for(const schema of[Config,new Schema(JSON.parse(JSON.stringify(Config)))])expect(schema(value).bindings.get()[0].cwd).toBe(cwd)
})
it.each(['relative/project','C:relative','\\relative','\\\\server'])('rejects relative or incomplete workspace %s in all schemas',cwd=>{
 const value={bindings:[{...binding(),cwd}]};expect(()=>pluginConfigSchema.parse(value)).toThrow()
 for(const schema of[Config,new Schema(JSON.parse(JSON.stringify(Config)))])expect(()=>schema(value)).toThrow()
})

it.each(['discord','feishu'])('rejects saved %s bindings before touching credentials, storage or runtime resources',async kind=>{
 for(const enabled of [false,true]){
  const retired={...binding('retired'),enabled,channel:{id:'retired',kind}}
  const config={bindings:[binding('a',false),retired]},before=structuredClone(config)
  const open=vi.fn(),resolve=vi.fn(),plugin=vi.fn(),register=vi.fn(),effect=vi.fn()
  const ctx={logger:()=>({warn:vi.fn()}),storageDomain:{open},credentials:{resolve},plugin,tools:{register},effect} as unknown as Context
  expect(pluginConfigSchema.safeParse(config).success).toBe(false)
  for(const schema of [Config,new Schema(JSON.parse(JSON.stringify(Config)))])expect(()=>schema(config)).toThrow()
  await expect(apply(ctx,config as never)).rejects.toThrow('Unsupported channel kind')
  expect(open).not.toHaveBeenCalled();expect(resolve).not.toHaveBeenCalled();expect(plugin).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();expect(effect).not.toHaveBeenCalled()
  expect(config).toEqual(before)
 }
})
it.each(['discord','feishu'])('rejects an external %s update while preserving accepted channel configuration',async kind=>{
 const safe=binding('a',false)
 let rows:unknown[]=[safe]
 const handlers=new Map<string,()=>void>(),releases:Array<()=>unknown>=[]
 const open=vi.fn(async()=>({close:async()=>{}})),resolve=vi.fn()
 let manager!:ChannelManager
 const ctx={logger:()=>({warn:vi.fn()}),get:()=>undefined,plugin:(_controller:unknown,value:ChannelManager)=>{manager=value},on:(name:string,fn:()=>void)=>handlers.set(name,fn),storageDomain:{open},credentials:{resolve},tools:{register:()=>()=>{}},effect:(fn:()=>()=>unknown)=>releases.push(fn())} as unknown as Context
 try{
  await apply(ctx,{bindings:{get:()=>rows},agents:{get:()=>[]}} as never)
  rows=[safe,{...binding('retired',false),channel:{id:'retired',kind}}]
  const before=structuredClone(rows)
  handlers.get('loader/volatile-update')!()
  expect(manager.bindings()).toEqual([safe]);expect(manager.status().configError).toBe('config-invalid')
  expect(rows).toEqual(before);expect(open).toHaveBeenCalledOnce();expect(resolve).not.toHaveBeenCalled()
 }finally{for(const release of releases.reverse())await release()}
})

it.each(['pending-start','pending-cleanup'] as const)('bounds unload while activation has %s',async mode=>{
  vi.useFakeTimers()
  const started=deferred<{close():Promise<void>}>(),log=vi.fn(),manager=new ChannelManager(()=>started.promise,log)
  const first=manager.update([binding()]).catch(()=>{})
  await Promise.resolve();await Promise.resolve()
  const closing=manager.close(),outcome=expect(closing).rejects.toThrow(/channel teardown/)
  expect(manager.close()).toBe(closing)
  if(mode==='pending-cleanup')started.resolve({close:()=>new Promise(()=>{})})
  try {
    await vi.advanceTimersByTimeAsync(15_000)
    await outcome
    expect(log).toHaveBeenCalled()
  } finally {vi.useRealTimers()}
  void first
})

it('retains ownership after a cancellation cleanup deadline and refuses a competing consumer',async()=>{
  vi.useFakeTimers()
  const started=deferred<{close():Promise<void>}>(),close=vi.fn(()=>new Promise<void>(()=>{})),start=vi.fn(()=>started.promise),manager=new ChannelManager(start)
  const first=manager.update([binding()]),firstResult=expect(first).rejects.toThrow('teardown')
  await Promise.resolve();await Promise.resolve()
  const stop=manager.update([binding('a',false)]),stopResult=expect(stop).rejects.toThrow('teardown')
  started.resolve({close})
  try {
    await vi.advanceTimersByTimeAsync(30_000)
    await firstResult;await stopResult
    const retry=manager.update([binding()]),retryResult=expect(retry).rejects.toThrow('teardown')
    await vi.advanceTimersByTimeAsync(15_000);await retryResult
    expect(start).toHaveBeenCalledOnce()
  } finally {vi.useRealTimers()}
})

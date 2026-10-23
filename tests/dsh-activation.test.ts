import {afterEach,expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import type {ChannelManager} from '../src/plugin/management.js'

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}}
afterEach(()=>{vi.doUnmock('../src/channels/telegram.js');vi.doUnmock('../src/plugin/bridge.js');vi.resetModules()})
async function setup(options:{importGate?:ReturnType<typeof deferred<void>>;startGate?:ReturnType<typeof deferred<void>>}={}){
  vi.resetModules()
  const imported=vi.fn(),constructed=vi.fn(),instances:Array<{active:boolean;start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>}>=[]
  vi.doMock('../src/channels/telegram.js',async()=>{
    imported();await options.importGate?.promise
    return {TelegramAdapter:class {
      active=false
      start=vi.fn(async()=>{await options.startGate?.promise;this.active=true})
      stop=vi.fn(async()=>{this.active=false})
      constructor(){constructed();instances.push(this)}
    }}
  })
  const bridgeClose=vi.fn(async()=>{})
  vi.doMock('../src/plugin/bridge.js',()=>({ChannelBridge:class {setConnected(){}close=bridgeClose}}))
  const {apply}=await import('../src/plugin/index.js')
  const {pluginConfigSchema}=await import('../src/plugin/config.js')
  const binding=pluginConfigSchema.parse({bindings:[{id:'synthetic',enabled:true,cwd:process.cwd(),credentialRef:'SYNTHETIC_REF',permissionPreset:'workspace-write',channel:{id:'synthetic',kind:'telegram',botId:'123',ownerUserId:'456'}}]}).bindings[0]!
  const tables=new Map<string,Map<string,unknown>>(),effects:Array<()=>Promise<void>|void>=[]
  let manager!:ChannelManager
  const domainClose=vi.fn(async()=>{})
  const ctx={
    logger:()=>({warn:vi.fn()}),permissionPresets:{resolve:vi.fn()},credentials:{resolve:vi.fn(async()=>({value:'synthetic'}))},
    storageDomain:{open:async()=>({table:(name:string)=>{let rows=tables.get(name);if(!rows){rows=new Map();tables.set(name,rows)}return {get:(key:string)=>rows!.get(key),put:async(key:string,value:unknown)=>{rows!.set(key,value)}}},close:domainClose})},
    effect:(fn:()=>()=>Promise<void>|void)=>{effects.push(fn())},tools:{register:()=>()=>{}},get:()=>undefined,on:vi.fn(),
    plugin:(_controller:unknown,value:ChannelManager)=>{manager=value},
  } as unknown as Context
  const applying=apply(ctx,{bindings:[binding]})
  await vi.waitFor(()=>expect(imported).toHaveBeenCalledTimes(1))
  return {manager,binding,applying,imported,constructed,instances,bridgeClose,domainClose,stop:async()=>{await Promise.all(effects.map(fn=>fn()))}}
}
it('disabling while dynamic import is pending never constructs or starts a late adapter',async()=>{
  const gate=deferred<void>(),f=await setup({importGate:gate})
  const disable=f.manager.update([{...f.binding,enabled:false}])
  gate.resolve();await Promise.all([f.applying,disable])
  expect(f.constructed).not.toHaveBeenCalled();expect(f.instances).toHaveLength(0)
  await f.stop();expect(f.domainClose).toHaveBeenCalledTimes(1)
})
it('disabling during adapter start drains and stops a resource that becomes active late',async()=>{
  const gate=deferred<void>(),f=await setup({startGate:gate})
  await vi.waitFor(()=>expect(f.instances[0]?.start).toHaveBeenCalledTimes(1))
  let disabled = false
  const disable=f.manager.update([{...f.binding,enabled:false}]).then(() => { disabled = true })
  await vi.waitFor(() => expect(f.instances[0]!.stop).toHaveBeenCalledTimes(1))
  expect(disabled).toBe(false)
  gate.resolve();await Promise.all([f.applying,disable])
  expect(f.instances[0]!.active).toBe(false);expect(f.instances[0]!.stop).toHaveBeenCalled()
  await f.stop()
})
it('repeated cancellation shares cleanup and re-enable waits for the old start to settle',async()=>{
  const gate=deferred<void>(),f=await setup({startGate:gate})
  await vi.waitFor(()=>expect(f.instances[0]?.start).toHaveBeenCalledTimes(1))
  const off=f.manager.update([{...f.binding,enabled:false}]),again=f.manager.update([{...f.binding,enabled:false}])
  const restart=f.manager.update([f.binding]);await Promise.resolve();expect(f.instances).toHaveLength(1)
  gate.resolve();await Promise.all([f.applying,off,again,restart])
  expect(f.instances).toHaveLength(2);expect(f.instances[0]!.active).toBe(false);expect(f.instances[1]!.active).toBe(true)
  const stopsBefore=f.instances[0]!.stop.mock.calls.length;await f.stop();await f.stop()
  expect(f.instances[0]!.stop).toHaveBeenCalledTimes(stopsBefore);expect(f.instances[1]!.active).toBe(false);expect(f.domainClose).toHaveBeenCalledTimes(1)
})

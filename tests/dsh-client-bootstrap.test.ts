import {afterEach,expect,it,vi} from 'vitest'
import {installPanel} from '../src/client/bootstrap.js'
import type {ClientContext,PermissionCatalog} from '../src/client/contracts.js'

afterEach(()=>vi.useRealTimers())
const catalog:PermissionCatalog={options:[{value:'workspace-write',name:'Workspace'}],defaultOptions:[],defaultPreset:'workspace-write'}
function fixture(api?:{catalog():Promise<{ok:true;value:PermissionCatalog}>}){
  const register=vi.fn(()=>()=>{}),releasePermission=vi.fn()
  const ctx={
    remote:{$mount:async()=>async()=>{},permissionPresets:api},
    inject(dependencies:string[],mount:(ctx:unknown)=>()=>void){
      const permission=dependencies.includes('remote.permissionPresets')
      const release=permission&&!api?undefined:mount(this)
      return Object.assign(Promise.resolve(),{dispose:async()=>{release?.();if(permission)releasePermission()}})
    },
    configForms:{get:()=>({}),whileServed:(_ids:unknown,mount:()=>unknown)=>mount()},
    slots:{inject:(_slot:unknown,mount:()=>unknown)=>mount(),register},
  } as unknown as ClientContext
  return {ctx,register,releasePermission}
}

it.each(['missing','hanging'] as const)('mounts the fallback after 1.5s when the permission catalog is %s',async mode=>{
  vi.useFakeTimers()
  let finish!:(value:{ok:true;value:PermissionCatalog})=>void
  const f=fixture(mode==='missing'?undefined:{catalog:()=>new Promise(resolve=>{finish=resolve})})
  const installing=installPanel(f.ctx,{})
  await vi.advanceTimersByTimeAsync(1500)
  const dispose=await installing
  expect(f.register).toHaveBeenCalledOnce()
  const options=f.register.mock.calls[0]![0] as unknown as {inject():{presets?:PermissionCatalog}}
  expect(options.inject().presets).toBeUndefined()
  if(mode==='hanging'){finish({ok:true,value:catalog});await Promise.resolve();expect(f.register).toHaveBeenCalledOnce()}
  await dispose()
  expect(f.releasePermission).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('provides a ready catalog and clears its fallback timer',async()=>{
  vi.useFakeTimers()
  const f=fixture({catalog:async()=>({ok:true,value:catalog})}),dispose=await installPanel(f.ctx,{})
  const options=f.register.mock.calls[0]![0] as unknown as {inject():{presets?:PermissionCatalog}}
  expect(options.inject().presets).toEqual(catalog)
  expect(vi.getTimerCount()).toBe(0)
  await dispose()
})

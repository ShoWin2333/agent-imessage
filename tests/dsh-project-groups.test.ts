import {expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import {ChannelProjectGroups,ChannelProjectsController,projectBindingKey,apply} from '../src/plugin/project-groups.js'
import {pluginConfigSchema} from '../src/plugin/config.js'

const binding=(id='alice-telegram',cwd='/synthetic/alice',enabled=true)=>pluginConfigSchema.parse({bindings:[{id,enabled,cwd,credentialRef:'SYNTHETIC_REF',permissionPreset:'workspace-write',channel:{id,kind:'telegram',botId:'123',ownerUserId:'456'}}]}).bindings[0]!
function fixture(){
  let bindings=[binding()]
  const rows=new Map<string,unknown>(),headers=new Map<string,{header:{cwd?:string}}>(),attached:string[]=[],projects=new Map<string,{id:string;path:string;title:string;attachSession:(id:string)=>Promise<void>}>()
  const canonical=vi.fn(async(path:string)=>path==='/synthetic/alias'?'/synthetic/alice':path)
  const describe=vi.fn(()=>[{ns:'agent-imessage-dsh-channels',value:{bindings}}])
  const stat=vi.fn(async(id:string)=>headers.get(id))
  const create=vi.fn(async(cwd:string,title?:string)=>{let value=projects.get(cwd);if(!value){value={id:`workspace-${projects.size}`,path:cwd,title:title??'Existing directory',attachSession:vi.fn(async(id:string)=>{if(!attached.includes(id))attached.push(id)})};projects.set(cwd,value)}return value})
  const ctx={settings:{describe},storageDomain:{get:vi.fn(()=>({table:vi.fn(()=>({get:(key:string)=>rows.get(key)}))}))},sessionPersistence:{stat},workspaceRegistry:{create}}
  const own=(suffix:string,b=bindings[0]!)=>{const key=projectBindingKey({...b,cwd:b.cwd==='/synthetic/alias'?'/synthetic/alice':b.cwd}),id=`channels-${key}-${suffix}`;return {key,id}}
  return {ctx,canonical,describe,stat,create,rows,headers,attached,projects,own,setBindings:(value:typeof bindings)=>{bindings=value},groups:new ChannelProjectGroups(ctx,canonical)}
}
it('repairs exact owned current and receipt session metadata without changing IDs or histories',async()=>{
  const f=fixture(),a=f.own('current'),b=f.own('history')
  const receipts=[{sessionId:b.id,id:'external-id',inputId:'original-input',result:{text:'history must stay untouched'}}]
  const row={sessionId:a.id,receipts};f.rows.set(a.key,row)
  f.headers.set(a.id,{header:{cwd:'/synthetic/alice'}});f.headers.set(b.id,{header:{cwd:'/synthetic/alias'}})
  const original=structuredClone(row);await f.groups.refresh()
  expect(f.attached).toEqual([a.id,b.id]);expect(row).toEqual(original)
  expect(f.create).toHaveBeenCalledWith('/synthetic/alice','Alice')
  expect(f.groups.status()).toEqual({projects:[{id:'workspace-0',cwd:'/synthetic/alice',title:'Alice',bindingIds:['alice-telegram']}],pending:[],errors:[]})
  expect(f.describe).toHaveBeenCalledWith({redactSecrets:true})
  expect(Object.keys(f.ctx.sessionPersistence)).toEqual(['stat'])
})
it('does not touch foreign, wrong-prefix, missing-header or wrong-cwd sessions',async()=>{
  const f=fixture(),a=f.own('wrong-cwd'),b=f.own('missing')
  f.rows.set(a.key,{sessionId:a.id,receipts:[{sessionId:'foreign'},{sessionId:'channels-other-not-owned'},{sessionId:b.id}]})
  f.headers.set(a.id,{header:{cwd:'/synthetic/other'}});await f.groups.refresh()
  expect(f.create).toHaveBeenCalledWith('/synthetic/alice','Alice');expect(f.attached).toEqual([])
  expect(f.stat.mock.calls.map(args=>args[0])).toEqual([a.id,b.id])
})
it('uses current binding keys only; disabled bindings never write metadata',async()=>{
  const f=fixture(),old=f.own('old');f.rows.set(old.key,{sessionId:old.id});f.headers.set(old.id,{header:{cwd:'/synthetic/alice'}})
  f.setBindings([{...binding(),model:{provider:'changed',model:'new'}}]);await f.groups.refresh();expect(f.attached).toEqual([])
  f.create.mockClear();f.setBindings([binding('alice-telegram','/synthetic/alice',false)]);await f.groups.refresh();expect(f.create).not.toHaveBeenCalled()
})
it('reuses the native same-cwd project, retains its name, and never impersonates unknown Agent IDs',async()=>{
  const f=fixture(),alice=binding(),unknown={...binding('external'),channel:{...binding('external').channel,botId:'789'}}
  f.setBindings([alice,unknown]);const a=f.own('a',alice),b=f.own('b',unknown)
  f.rows.set(a.key,{sessionId:a.id});f.rows.set(b.key,{sessionId:b.id});for(const id of[a.id,b.id])f.headers.set(id,{header:{cwd:'/synthetic/alice'}})
  const attachSession=vi.fn(async(id:string)=>{f.attached.push(id)})
  f.projects.set('/synthetic/alice',{id:'existing-project',path:'/synthetic/alice',title:'Existing native title',attachSession})
  await f.groups.refresh();expect(attachSession).toHaveBeenCalledWith(a.id);expect(attachSession).toHaveBeenCalledWith(b.id)
  expect(f.create.mock.calls[1]![1]).toBeUndefined()
  expect(f.groups.status().projects).toEqual([{id:'existing-project',cwd:'/synthetic/alice',title:'Existing native title',bindingIds:['alice-telegram','external']}])
})
it('handles new owned session events and ignores unrelated event prefixes',async()=>{
  const f=fixture(),a=f.own('new');f.rows.set(a.key,{sessionId:a.id});f.headers.set(a.id,{header:{cwd:'/synthetic/alice'}})
  await f.groups.sessionCreated('channels-not-current-no');expect(f.describe).not.toHaveBeenCalled()
  await f.groups.sessionCreated(a.id);expect(f.attached).toEqual([a.id])
})
it('fences an in-flight header lookup on disable/close and sanitizes errors',async()=>{
  const f=fixture(),a=f.own('pending');f.rows.set(a.key,{sessionId:a.id})
  let resolve!:(value:{header:{cwd:string}})=>void
  f.stat.mockImplementation(()=>new Promise(r=>{resolve=r}))
  const first=f.groups.refresh();await vi.waitFor(()=>expect(f.stat).toHaveBeenCalled())
  const closed=f.groups.close();resolve({header:{cwd:'/synthetic/alice'}});await Promise.all([first,closed]);expect(f.attached).toEqual([])
  const g=fixture(),b=g.own('error');g.rows.set(b.key,{sessionId:b.id});g.headers.set(b.id,{header:{cwd:'/synthetic/alice'}})
  g.create.mockRejectedValue(new Error('secret/path/should-never-appear'));await g.groups.refresh()
  expect(JSON.stringify(g.groups.status())).not.toContain('secret/path');expect(g.groups.status().errors).toHaveLength(1)
})
it('status is read-only and returns detached metadata',async()=>{
  const f=fixture();await f.groups.refresh();f.create.mockClear();f.stat.mockClear();f.describe.mockClear()
  const controller={groups:f.groups} as unknown as ChannelProjectsController
  const status=ChannelProjectsController.prototype.status.call(controller);status.pending.push('mutated')
  expect(f.groups.status().pending).toEqual([]);expect(f.create).not.toHaveBeenCalled();expect(f.stat).not.toHaveBeenCalled();expect(f.describe).not.toHaveBeenCalled()
})
it('a queued disabled configuration supersedes an in-flight repair',async()=>{
  const f=fixture(),a=f.own('race');f.rows.set(a.key,{sessionId:a.id})
  let release!:(value:{header:{cwd:string}})=>void
  f.stat.mockImplementation(()=>new Promise(resolve=>{release=resolve}))
  const first=f.groups.refresh();await vi.waitFor(()=>expect(f.stat).toHaveBeenCalled())
  f.setBindings([binding('alice-telegram','/synthetic/alice',false)])
  const next=f.groups.refresh();release({header:{cwd:'/synthetic/alice'}})
  await Promise.all([first,next]);expect(f.attached).toEqual([]);expect(f.groups.status()).toEqual({projects:[],pending:[],errors:[]})
})
it('withdrawn ownership during workspace creation cannot attach a session',async()=>{
  const f=fixture(),a=f.own('withdrawn');f.rows.set(a.key,{sessionId:a.id});f.headers.set(a.id,{header:{cwd:'/synthetic/alice'}})
  const attachSession=vi.fn(async()=>{})
  f.create.mockImplementation(async()=>{f.rows.delete(a.key);return {id:'existing',path:'/synthetic/alice',title:'Alice',attachSession}})
  await f.groups.refresh();expect(attachSession).not.toHaveBeenCalled();expect(f.groups.status().projects).toEqual([{id:'existing',cwd:'/synthetic/alice',title:'Alice',bindingIds:['alice-telegram']}])
})
it('maps enabled canonical directories to native projects before any channel session exists',async()=>{
  const f=fixture();await f.groups.refresh()
  expect(f.stat).not.toHaveBeenCalled();expect(f.attached).toEqual([])
  expect(f.groups.status().projects).toEqual([{id:'workspace-0',cwd:'/synthetic/alice',title:'Alice',bindingIds:['alice-telegram']}])
})
it('subentry uses public metadata events and never reopens the owned channel domain',async()=>{
  const f=fixture(),listeners=new Map<string,(...args:any[])=>unknown>(),effects:Array<()=>Promise<void>>=[]
  const ctx={...f.ctx,effect:(fn:()=>()=>Promise<void>)=>{effects.push(fn())},plugin:vi.fn(),on:(event:string,listener:(...args:any[])=>unknown)=>{listeners.set(event,listener)}}
  await apply(ctx as unknown as Context)
  expect(ctx.plugin).toHaveBeenCalledWith(ChannelProjectsController,expect.any(ChannelProjectGroups))
  expect([...listeners.keys()]).toEqual(['session/created','settings/document-updated','domain/changed'])
  f.describe.mockClear();listeners.get('domain/changed')!({domain:'another',table:'bindings'});await Promise.resolve();expect(f.describe).not.toHaveBeenCalled()
  await effects[0]!();expect(Object.keys(f.ctx.storageDomain)).toEqual(['get'])
})

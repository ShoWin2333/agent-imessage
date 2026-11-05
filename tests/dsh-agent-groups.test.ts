import {expect,it,vi} from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {Config} from '../src/plugin/schema.js'
import {pluginConfigSchema} from '../src/plugin/config.js'
import {bindingKey,legacyBindingKey} from '../src/plugin/identity.js'
import {resolveAgentGroups,agentGroupIssue,type AgentGroup} from '../src/shared/agents.js'
import {ChannelManager} from '../src/plugin/management.js'
import {volatileForm,plainConfig,projectForm} from '../node_modules/@deepseek-ai/dsh-settings/lib/types/schema.js'

const binding=(id='alice-telegram',cwd='/tmp/alice',botId='123')=>pluginConfigSchema.parse({bindings:[{id,cwd,enabled:true,credentialRef:'REF',permissionPreset:'workspace-write',channel:{id,kind:'telegram',botId,ownerUserId:'456'}}]}).bindings[0]!
it('infers the previous prefix + cwd groups without changing any binding or session key',()=>{
 const rows=[binding(),binding('alice-discord','/tmp/alice','222'),binding('alice-feishu','/tmp/other','789'),binding('custom','/tmp/custom','999')]
 const before=structuredClone(rows),keys=rows.map(b=>[bindingKey(b),legacyBindingKey(b)])
 const groups=resolveAgentGroups(rows)
 expect(groups.map(g=>[g.name,g.cwd,g.bindingIds])).toEqual([
  ['Alice','/tmp/alice',['alice-telegram','alice-discord']],['Alice','/tmp/other',['alice-feishu']],['custom','/tmp/custom',['custom']],
 ])
 const migrated=pluginConfigSchema.parse({bindings:rows,agents:groups})
 expect(migrated.bindings).toEqual(before)
 expect(migrated.bindings.map(b=>[bindingKey(b),legacyBindingKey(b)])).toEqual(keys)
 expect(resolveAgentGroups(migrated.bindings,migrated.agents)).toEqual(groups)
})
it('persists empty groups and explicit membership independent of binding names or cwd',()=>{
 const row=binding(),agents=[{id:'a',name:'Renamed',cwd:'/tmp/default',bindingIds:[row.id]},{id:'empty',name:'Empty',cwd:'/tmp/empty',bindingIds:[]}]
 const value=pluginConfigSchema.parse({bindings:[row],agents})
 expect(resolveAgentGroups(value.bindings,value.agents)).toEqual(agents)
 expect(resolveAgentGroups([{...row,cwd:'/tmp/moved'}],agents)).toEqual(agents)
 expect(resolveAgentGroups([],agents.map(g=>({...g,bindingIds:[]})))).toHaveLength(2)
})
it('preserves configured groups while inferring externally added unassigned bindings with collision-free ids',()=>{
 const row=binding(),occupied:AgentGroup={id:'agent-alice-telegram',name:'Empty',cwd:'/tmp',bindingIds:[]}
 const groups=resolveAgentGroups([row],[occupied])
 expect(groups[0]).toEqual(occupied);expect(groups[1]!.id).not.toBe(occupied.id)
 expect(agentGroupIssue([row],groups)).toBeUndefined()
})
it.each([
 [{id:'a',name:'   ',cwd:'/tmp',bindingIds:[]}],
 [{id:'a',name:'A',cwd:'relative',bindingIds:[]}],
 [{id:'a',name:'A',cwd:'/tmp',bindingIds:['missing']}],
 [{id:'a',name:'A',cwd:'/tmp',bindingIds:['alice-telegram','alice-telegram']}],
 [{id:'a',name:'A',cwd:'/tmp',bindingIds:['alice-telegram']},{id:'b',name:'B',cwd:'/tmp',bindingIds:['alice-telegram']}],
 [{id:'a',name:'A',cwd:'/tmp',bindingIds:[]},{id:'a',name:'B',cwd:'/tmp',bindingIds:[]}],
])('rejects invalid metadata and duplicate or dangling membership: %j',(...agents)=>{
 expect(pluginConfigSchema.safeParse({bindings:[binding()],agents}).success).toBe(false)
})
it('enforces the group limit including unassigned legacy bindings',()=>{
 const agents=Array.from({length:32},(_,i)=>({id:`a${i}`,name:`A ${i}`,cwd:'/tmp',bindingIds:[]}))
 expect(pluginConfigSchema.safeParse({agents}).success).toBe(true)
 expect(pluginConfigSchema.safeParse({agents,bindings:[binding()]}).success).toBe(false)
 expect(pluginConfigSchema.safeParse({agents:[...agents,{...agents[0],id:'extra'}]}).success).toBe(false)
})
it('survives native schema projection and wire rehydration with empty groups',()=>{
 const value={bindings:[binding()],agents:resolveAgentGroups([binding()]).concat({id:'empty',name:'Empty',cwd:'/tmp',bindingIds:[]})}
 for(const schema of [Config,new Schema(JSON.parse(JSON.stringify(Config)))]){
  const form=volatileForm(schema)!,browser=new Schema(JSON.parse(JSON.stringify(form)))
  expect(browser(projectForm(form,plainConfig(schema(value))))).toEqual(value)
 }
})
it('metadata migration does not restart consumers; removing configuration closes only the selected consumers',async()=>{
 const a=binding(),b=binding('jane-telegram','/tmp/jane','789'),closes=new Map<string,ReturnType<typeof vi.fn>>()
 const start=vi.fn(async(row:ReturnType<typeof binding>)=>{const close=vi.fn(async()=>{});closes.set(row.id,close);return{close}})
 const manager=new ChannelManager(start)
 try{
  await manager.update([a,b])
  const migrated=pluginConfigSchema.parse({bindings:[a,b],agents:resolveAgentGroups([a,b])})
  await manager.update(migrated.bindings)
  expect(start).toHaveBeenCalledTimes(2);expect(closes.get(a.id)).not.toHaveBeenCalled()
  const remaining=migrated.agents.filter(g=>!g.bindingIds.includes(a.id))
  await manager.update(pluginConfigSchema.parse({bindings:[b],agents:remaining}).bindings)
  expect(closes.get(a.id)).toHaveBeenCalledOnce();expect(closes.get(b.id)).not.toHaveBeenCalled()
 }finally{await manager.close()}
})

it('commits groups and channel removal together through native Settings mutate, with stale revision rejection',async()=>{
 const {SettingsForms}=await import('@deepseek-ai/dsh-settings')
 const rows=[binding()],agents=resolveAgentGroups(rows)
 let raw={bindings:rows,agents}
 const entry={options:{id:'dsh-channels'},fiber:{runtime:{Config}}}
 const edit=vi.fn(async(_entry:unknown,change:(raw:unknown,inherited:unknown)=>typeof raw)=>{
  const next=change(raw,{})
  raw=pluginConfigSchema.parse(next)
 })
 const native=Object.create(SettingsForms.prototype)
 Object.assign(native,{ownerContext:{configEditor:{entries:()=>[entry],edit}},describe:()=>[{ns:'dsh-channels',revision:7}]})
 await native.mutate('dsh-channels',[{op:'set',path:['bindings'],value:[]},{op:'set',path:['agents'],value:agents.map(g=>({...g,bindingIds:[]}))}],7)
 expect(edit).toHaveBeenCalledOnce();expect(raw).toEqual({bindings:[],agents:agents.map(g=>({...g,bindingIds:[]}))})
 await expect(native.mutate('dsh-channels',[{op:'set',path:['agents'],value:[]}],6)).rejects.toThrow(/changed since it was read/)
 expect(raw.agents).toHaveLength(1)
})
it('validates volatile group metadata on Host updates before interrupting accepted bindings',async()=>{
 const {apply}=await import('../src/plugin/index.js')
 const disabled={...binding(),enabled:false},rows=[disabled]
 let agents=resolveAgentGroups(rows)
 const update=vi.spyOn(ChannelManager.prototype,'update'),handlers=new Map<string,()=>void>(),releases:Array<()=>Promise<void>>=[]
 const ctx={logger:()=>({warn:vi.fn()}),plugin:vi.fn(),get:()=>undefined,on:(name:string,fn:()=>void)=>handlers.set(name,fn),tools:{register:()=>()=>{}},storageDomain:{open:async()=>({close:async()=>{}})},effect:(fn:()=>()=>Promise<void>)=>releases.push(fn())}
 try{
  await apply(ctx as never,{bindings:{get:()=>rows},agents:{get:()=>agents}} as never)
  expect(update).toHaveBeenCalledOnce();expect(update).toHaveBeenLastCalledWith(rows)
  agents=[{...agents[0]!,bindingIds:['missing']}]
  handlers.get('loader/volatile-update')!()
  expect(update).toHaveBeenCalledOnce()
  agents=[];handlers.get('loader/volatile-update')!()
  expect(update).toHaveBeenCalledTimes(2)
 }finally{for(const release of releases.reverse())await release();update.mockRestore()}
})

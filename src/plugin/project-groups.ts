import {createHash} from 'node:crypto'
import {realpath} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import {Remote,TypertRemoteService} from '@deepseek-ai/dsh-typert-protocol'
import {pluginConfigSchema,type Binding} from './config.js'

const NAMESPACE='agent-imessage-dsh-channels',DOMAIN='dsh_channels_v1'
interface Workspace {id:string;path:string;title:string;attachSession(id:string):Promise<void>}
interface ProjectContext {
  settings:{describe(options:{redactSecrets:true}):Array<{ns:string;value:unknown}>}
  storageDomain:{get(name:string):{table(name:string):{get(key:string):unknown}}|undefined}
  sessionPersistence:{stat(id:string):Promise<{header:{cwd?:string}}|undefined>}
  workspaceRegistry:{create(cwd:string,title?:string):Promise<Workspace>}
}
export interface ChannelProject {id:string;cwd:string;title:string;bindingIds:string[]}
export interface ProjectGroupStatus {projects:ChannelProject[];pending:string[];errors:Array<{bindingId:string;message:string}>}
/** Match the channel's durable key exactly, including canonical cwd, excluding activation. */
export function projectBindingKey(binding:Binding):string {
  const {enabled:_,...identity}=binding
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
function sessionIds(value:unknown,key:string):string[] {
  if(!value||typeof value!=='object')return []
  const row=value as {sessionId?:unknown;receipts?:unknown}
  const ids:unknown[]=[row.sessionId]
  if(Array.isArray(row.receipts))for(const receipt of row.receipts)if(receipt&&typeof receipt==='object')ids.push((receipt as {sessionId?:unknown}).sessionId)
  return [...new Set(ids.filter((id):id is string=>typeof id==='string'&&id.startsWith(`channels-${key}-`)&&id.length>`channels-${key}-`.length))]
}
const projectTitle=(id:string)=>/^(.+)-(?:imessage|telegram|weixin|discord)(?:-|$)/.exec(id)?.[1]?.replace(/^./,c=>c.toUpperCase())

/** Independent metadata contribution: never opens histories, agents, transports or the channel domain. */
export class ChannelProjectGroups {
  private tail=Promise.resolve()
  private generation=0
  private closed=false
  private value:ProjectGroupStatus={projects:[],pending:[],errors:[]}
  constructor(private readonly ctx:ProjectContext,private readonly canonical:(path:string)=>Promise<string>=realpath){}
  status():ProjectGroupStatus{return structuredClone(this.value)}
  async sessionCreated(id:string):Promise<void>{
    if(this.closed||!/^channels-[a-f0-9]{64}-.+/.test(id))return
    try {
      const descriptor=this.ctx.settings.describe({redactSecrets:true}).find(row=>row.ns===NAMESPACE)
      if(!descriptor)return
      for(const binding of pluginConfigSchema.parse(descriptor.value).bindings){
        if(!binding.enabled)continue
        const key=projectBindingKey({...binding,cwd:await this.canonical(binding.cwd)})
        if(id.startsWith(`channels-${key}-`)){await this.refresh();return}
      }
    }catch{ /* Configuration errors are reported by the next serialized refresh. */ }
  }
  refresh():Promise<void>{
    if(this.closed)return Promise.resolve()
    const generation=++this.generation
    const task=this.tail.then(()=>this.reconcile(generation))
    this.tail=task.catch(()=>{if(!this.closed)this.value={...this.value,pending:[],errors:[{bindingId:'',message:'项目归属配置暂不可用；现有会话保持不变。'}]}})
    return this.tail
  }
  private active(generation:number){return !this.closed&&generation===this.generation}
  private async bindingCurrent(bindingId:string,key:string,generation:number):Promise<boolean>{
    if(!this.active(generation))return false
    const descriptor=this.ctx.settings.describe({redactSecrets:true}).find(row=>row.ns===NAMESPACE)
    if(!descriptor)return false
    const binding=pluginConfigSchema.parse(descriptor.value).bindings.find(b=>b.id===bindingId&&b.enabled)
    if(!binding)return false
    const cwd=await this.canonical(binding.cwd)
    return this.active(generation)&&projectBindingKey({...binding,cwd})===key
  }
  private async reconcile(generation:number):Promise<void>{
    if(!this.active(generation))return
    const descriptor=this.ctx.settings.describe({redactSecrets:true}).find(row=>row.ns===NAMESPACE)
    if(!descriptor){this.value={projects:[],pending:[],errors:[]};return}
    const bindings=pluginConfigSchema.parse(descriptor.value).bindings.filter(b=>b.enabled)
    const domain=this.ctx.storageDomain.get(DOMAIN)
    if(!domain){this.value={projects:[],pending:bindings.map(b=>b.id),errors:[]};return}
    const result:ProjectGroupStatus={projects:[],pending:[],errors:[]}
    this.value=structuredClone(result)
    for(const binding of bindings){
      if(!this.active(generation))return
      result.pending.push(binding.id);this.value=structuredClone(result)
      try {
        const cwd=await this.canonical(binding.cwd),key=projectBindingKey({...binding,cwd})
        if(!await this.bindingCurrent(binding.id,key,generation)){
          result.pending=result.pending.filter(id=>id!==binding.id)
          if(this.active(generation))this.value=structuredClone(result)
          continue
        }
        const workspace=await this.ctx.workspaceRegistry.create(cwd,projectTitle(binding.id))
        if(!this.active(generation))return
        if(workspace.path!==cwd)throw new Error('Workspace path mismatch')
        const candidates=sessionIds(domain.table('bindings').get(key),key)
        for(const id of candidates){
          if(!this.active(generation))return
          const snapshot=await this.ctx.sessionPersistence.stat(id)
          if(!snapshot?.header.cwd)continue
          if(await this.canonical(snapshot.header.cwd)!==cwd)continue
          // Re-read the authoritative ownership account after every async header/path read.
          if(!sessionIds(domain.table('bindings').get(key),key).includes(id))continue
          if(!await this.bindingCurrent(binding.id,key,generation))continue
          if(!sessionIds(domain.table('bindings').get(key),key).includes(id))continue
          await workspace.attachSession(id)
        }
        if(await this.bindingCurrent(binding.id,key,generation)){
          const existing=result.projects.find(p=>p.id===workspace.id)
          if(existing)existing.bindingIds.push(binding.id)
          else result.projects.push({id:workspace.id,cwd:workspace.path,title:workspace.title,bindingIds:[binding.id]})
        }
      }catch{result.errors.push({bindingId:binding.id,message:'项目归属未完成；请检查项目目录和宿主元数据服务。'})}
      result.pending=result.pending.filter(id=>id!==binding.id)
      if(this.active(generation))this.value=structuredClone(result)
    }
  }
  async close():Promise<void>{this.closed=true;this.generation++;await this.tail}
}
export class ChannelProjectsController extends TypertRemoteService {
  constructor(ctx:Context,private readonly groups:ChannelProjectGroups){super(ctx,'channelProjectsController',{namespace:'channelProjects'})}
  @Remote('status')
  status():ProjectGroupStatus{return this.groups.status()}
}
export const name='dsh-channel-projects'
// The main controller is published only after it opens its domain. Waiting for
// that existing service avoids missing a loaded-but-never-mutated ownership row.
export const inject=['settings','storageDomain','sessionPersistence','workspaceRegistry','channelsController']
export async function apply(ctx:Context):Promise<void>{
  const groups=new ChannelProjectGroups(ctx as unknown as ProjectContext)
  ctx.effect(()=>()=>groups.close())
  ctx.plugin(ChannelProjectsController,groups)
  ctx.on('session/created',session=>{void groups.sessionCreated(session.id)},{global:true})
  ctx.on('settings/document-updated',ns=>{if(ns===NAMESPACE)void groups.refresh()},{global:true})
  ctx.on('domain/changed',change=>{if(change.domain===DOMAIN&&change.table==='bindings')void groups.refresh()},{global:true})
  await groups.refresh()
}

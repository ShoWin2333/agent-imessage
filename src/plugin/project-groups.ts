import {realpath} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import {Remote,TypertRemoteService} from '@deepseek-ai/dsh-typert-protocol'
import type {Binding} from './config.js'
import {bindingKey,ownedSessionIds} from './identity.js'

const DOMAIN='dsh_channels_v1'
interface Workspace {id:string;path:string;title:string;attachSession(id:string):Promise<void>}
interface ProjectContext {
  storageDomain:{get(name:string):{table(name:string):{get(key:string):unknown}}|undefined}
  sessionPersistence:{stat(id:string):Promise<{header:{cwd?:string}}|undefined>}
  workspaceRegistry:{create(cwd:string,title?:string):Promise<Workspace>}
}
export interface ChannelProject {id:string;cwd:string;title:string;bindingIds:string[]}
export interface ProjectGroupStatus {projects:ChannelProject[];pending:string[];errors:Array<{bindingId:string;code:string}>}
/** Match the channel's durable key exactly, including canonical cwd, excluding activation. */
export function projectBindingKey(binding:Binding):string{return bindingKey(binding)}
const projectTitle=(id:string)=>/^(.+)-(?:imessage|telegram|weixin|discord)(?:-|$)/.exec(id)?.[1]?.replace(/^./,c=>c.toUpperCase())

/**
 * Independent metadata contribution: never opens histories, agents, transports or the
 * channel domain. Bindings come from the live Channel Manager, so a saved draft and the
 * runtime can never disagree about which sessions this plugin owns.
 */
export class ChannelProjectGroups {
  private tail=Promise.resolve()
  private generation=0
  private closed=false
  private value:ProjectGroupStatus={projects:[],pending:[],errors:[]}
  constructor(private readonly ctx:ProjectContext,private readonly bindings:()=>readonly Binding[],private readonly canonical:(path:string)=>Promise<string>=realpath){}
  status():ProjectGroupStatus{return structuredClone(this.value)}
  private enabled():Binding[]{return this.bindings().filter(binding=>binding.enabled)}
  async sessionCreated(id:string):Promise<void>{
    if(this.closed||!/^channels-[a-f0-9]{64}-.+/.test(id))return
    for(const binding of this.enabled()){
      const key=await this.keyOf(binding),row=this.ctx.storageDomain.get(DOMAIN)?.table('bindings').get(key)
      if(id.startsWith(`channels-${key}-`)||ownedSessionIds(row,key).includes(id)){await this.refresh();return}
    }
  }
  refresh():Promise<void>{
    if(this.closed)return Promise.resolve()
    const generation=++this.generation
    const task=this.tail.then(()=>this.reconcile(generation))
    this.tail=task.catch(()=>{if(!this.closed)this.value={...this.value,pending:[],errors:[{bindingId:'',code:'project-groups-unavailable'}]}})
    return this.tail
  }
  private active(generation:number){return !this.closed&&generation===this.generation}
  private async keyOf(binding:Binding):Promise<string>{return bindingKey({...binding,cwd:await this.canonical(binding.cwd)})}
  private async bindingCurrent(bindingId:string,key:string,generation:number):Promise<boolean>{
    if(!this.active(generation))return false
    const binding=this.bindings().find(b=>b.id===bindingId&&b.enabled)
    return binding!==undefined&&await this.keyOf(binding)===key
  }
  private async reconcile(generation:number):Promise<void>{
    if(!this.active(generation))return
    const bindings=this.enabled()
    const domain=this.ctx.storageDomain.get(DOMAIN)
    if(!domain){this.value={projects:[],pending:bindings.map(b=>b.id),errors:[]};return}
    const result:ProjectGroupStatus={projects:[],pending:[],errors:[]}
    this.value=structuredClone(result)
    for(const binding of bindings){
      if(!this.active(generation))return
      result.pending.push(binding.id);this.value=structuredClone(result)
      try {
        const cwd=await this.canonical(binding.cwd),key=await this.keyOf(binding)
        if(!await this.bindingCurrent(binding.id,key,generation)){
          result.pending=result.pending.filter(id=>id!==binding.id)
          if(this.active(generation))this.value=structuredClone(result)
          continue
        }
        const workspace=await this.ctx.workspaceRegistry.create(cwd,projectTitle(binding.id))
        if(!this.active(generation))return
        if(workspace.path!==cwd)throw new Error('Workspace path mismatch')
        const candidates=ownedSessionIds(domain.table('bindings').get(key),key)
        for(const id of candidates){
          if(!this.active(generation))return
          const snapshot=await this.ctx.sessionPersistence.stat(id)
          if(!snapshot?.header.cwd)continue
          if(await this.canonical(snapshot.header.cwd)!==cwd)continue
          // Re-read the authoritative ownership account after every async header/path read.
          if(!ownedSessionIds(domain.table('bindings').get(key),key).includes(id))continue
          if(!await this.bindingCurrent(binding.id,key,generation))continue
          if(!ownedSessionIds(domain.table('bindings').get(key),key).includes(id))continue
          await workspace.attachSession(id)
        }
        if(await this.bindingCurrent(binding.id,key,generation)){
          const existing=result.projects.find(p=>p.id===workspace.id)
          if(existing)existing.bindingIds.push(binding.id)
          else result.projects.push({id:workspace.id,cwd:workspace.path,title:workspace.title,bindingIds:[binding.id]})
        }
      }catch{result.errors.push({bindingId:binding.id,code:'project-group-failed'})}
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
// The main controller publishes the live binding list; waiting for it also prevents
// this metadata contribution from racing the channel domain.
export const inject=['storageDomain','sessionPersistence','workspaceRegistry','channelsController']
export async function apply(ctx:Context):Promise<void>{
  const controller=ctx.channelsController
  const groups=new ChannelProjectGroups(ctx as unknown as ProjectContext,()=>controller.bindings())
  ctx.effect(()=>()=>groups.close())
  ctx.plugin(ChannelProjectsController,groups)
  ctx.on('session/created',session=>{void groups.sessionCreated(session.id)},{global:true})
  // Status transitions are frequent; only a binding-list change needs a metadata refresh.
  const signature=(bindings:readonly Binding[])=>JSON.stringify(bindings.map(b=>[b.id,b.enabled,b.cwd,b.channel,b.permissionPreset,b.model]))
  let seen=signature(controller.bindings())
  const release=controller.subscribe(()=>{
    const next=signature(controller.bindings())
    if(next===seen)return
    seen=next
    void groups.refresh()
  })
  ctx.effect(()=>release)
  ctx.on('domain/changed',change=>{if(change.domain===DOMAIN&&change.table==='bindings')void groups.refresh()},{global:true})
  await groups.refresh()
}

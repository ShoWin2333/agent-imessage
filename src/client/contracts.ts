import type {AgentGroup} from '../shared/agents.js'
export interface Binding {
  id: string
  enabled: boolean
  cwd: string
  credentialRef: string
  permissionPreset: string
  channel: {id:string;kind:'imessage'|'telegram'|'weixin'|'qqbot';[key:string]:string|boolean|number|undefined}
  weixin?: {ownerUserId:string;baseUrl:string}
  model?: {provider:string;model:string;reasoningEffort?:string}
}
export type {AgentGroup} from '../shared/agents.js'
export interface ChannelConfig {bindings?:Binding[];agents?:AgentGroup[]}
export interface FormSnapshot {status:string;value?:ChannelConfig;revision?:number;writable:boolean}
export type ConfigMutation={op:'set';path:['bindings'];value:Binding[]}|{op:'set';path:['agents'];value:AgentGroup[]}
export interface ConfigForm {
  getSnapshot():FormSnapshot
  subscribe(listener:()=>void):()=>void
  mutate(ops:ConfigMutation[],revision?:number):Promise<boolean>
}
export interface Catalog {
  default:{provider:string;model:string;reasoningEffort?:string}
  groups:Array<{id:string;name:string;models:Array<{id:string;name:string;reasoning?:{efforts:Array<{id:string;name:string}>;defaultEffort?:string}}> }>
  failures:Array<{id:string;message:string}>
}
export interface RuntimeStatus {id:string;phase:string;error?:string;sessionId?:string}
export interface StatusFrame {bindings:RuntimeStatus[];configError?:string}
export interface ProjectStatus {projects:Array<{id:string;title:string;cwd:string;bindingIds:string[]}>;pending:string[];errors:Array<{bindingId:string;code:string}>}
export type Result<T>={ok:true;value:T}|{ok:false;error?:{message?:string;code?:string}}
/** One selectable Host permission preset (labels are localized by the Host). */
export interface PermissionOption {value:string;name:string;description?:string}
export interface PermissionCatalog {options:PermissionOption[];defaultOptions:PermissionOption[];defaultPreset:string}
/** Read-only Host catalog used by the official permission pickers. */
export interface PermissionApi {catalog():Promise<Result<PermissionCatalog>>}
export interface ChannelsApi {status():Promise<Result<StatusFrame>>;statusStream(signal?:AbortSignal):AsyncIterable<StatusFrame>}
export interface ClientLocale {
  bind(ns:string):(key:string)=>string
  register(ns:string,locale:'en'|'zh',dict:Record<string,string>):()=>void
  subscribe(listener:()=>void):()=>void
}
export interface QQSetupState {id:string;phase:'waiting'|'saving'|'complete'|'failed'|'cancelled';url?:string;qrSvg?:string;appId?:string;ownerUserId?:string;credentialRef?:string}
export interface ClientContext {
  inject(dependencies:string[],mount:(ctx:ClientContext)=>()=>void):PromiseLike<unknown>&{dispose():Promise<void>}
  configForms:{get(id:string):ConfigForm;whileServed(ids:string[],register:()=>()=>void):()=>void}
  slots:{inject(name:string,register:()=>unknown):()=>void;register(options:Record<string,unknown>,component:unknown):()=>void}
  uiWorkspace:{pickDirectory():Promise<string|null>}
  locale?:ClientLocale
  remote:{
    $mount(contribution:unknown):Promise<()=>Promise<void>|void>
    session:{modelCatalog():Promise<Result<Catalog>>}
    channelProjects?:{status():Promise<Result<ProjectStatus>>}
    qqBotSetup?:{start(reference:string):Promise<Result<QQSetupState>>;status(id:string):Promise<Result<QQSetupState>>;cancel(id:string):Promise<Result<void>>;runtime?():Promise<Result<{version:string;startedAt:string}>>;credentialStatus?(reference:string):Promise<Result<{configured:boolean;writable:boolean;source?:string}>>;saveCredential?(reference:string,value:string):Promise<Result<void>>}
    permissionPresets?:PermissionApi
    channels?:ChannelsApi
  }
  effect(effect:()=>()=>void,label?:string):unknown
}

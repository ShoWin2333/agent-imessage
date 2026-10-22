export interface Binding {
  id: string
  enabled: boolean
  cwd: string
  credentialRef: string
  permissionPreset: string
  channel: {id:string;kind:'imessage'|'telegram'|'weixin'|'discord';[key:string]:string}
  weixin?: {ownerUserId:string;baseUrl:string}
  model?: {provider:string;model:string;reasoningEffort?:string}
}
export interface FormSnapshot {status:string;value?:{bindings?:Binding[]};revision?:number;writable:boolean}
export interface ConfigForm {
  getSnapshot():FormSnapshot
  subscribe(listener:()=>void):()=>void
  mutate(ops:Array<{op:'set';path:string[];value:Binding[]}>,revision?:number):Promise<boolean>
}
export interface Catalog {
  default:{provider:string;model:string;reasoningEffort?:string}
  groups:Array<{id:string;name:string;models:Array<{id:string;name:string;reasoning?:{efforts:Array<{id:string;name:string}>;defaultEffort?:string}}> }>
  failures:Array<{id:string;message:string}>
}
export interface RuntimeStatus {id:string;phase:string;error?:string;sessionId?:string}
export type Result<T>={ok:true;value:T}|{ok:false;error?:{message?:string}}
export interface ClientContext {
  configForms:{get(id:string):ConfigForm;whileServed(ids:string[],register:()=>()=>void):()=>void}
  slots:{inject(name:string,register:()=>unknown):()=>void;register(options:Record<string,unknown>,component:unknown):()=>void}
  uiWorkspace:{pickDirectory():Promise<string|null>}
  remote:{$mount(contribution:unknown):Promise<()=>Promise<void>|void>;session:{modelCatalog():Promise<Result<Catalog>>};channelProjects?:{status():Promise<Result<{projects:Array<{id:string;title:string;cwd:string;bindingIds:string[]}>}>>};channels?:{status():Promise<Result<{bindings:RuntimeStatus[];configError?:string}>>}}
  effect(effect:()=>()=>void,label?:string):unknown
}

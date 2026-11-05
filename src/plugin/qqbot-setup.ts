import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { QrConnectCallbacks, QrConnectOptions, QrConnectCredentials } from '@tencent-connect/qqbot-connector'
import { renderQrSvgDataUrl } from '../channels/qqbot-official/qr-svg.js'
import { CREDENTIAL_RE } from '../shared/rules.js'
import {QQBOT_VERSION} from '../shared/qqbot-version.js'
export type QQSetupState={id:string;phase:'waiting'|'saving'|'complete'|'failed'|'cancelled';url?:string;qrSvg?:string;appId?:string;ownerUserId?:string;credentialRef?:string}
export class QQBotSetup {
  private scans=new Map<string,{state:QQSetupState;controller:AbortController;stop?:()=>void;task?:Promise<void>;expires:ReturnType<typeof setTimeout>}>()
  constructor(private readonly save:(reference:string,value:string)=>Promise<void>,private readonly configured:(reference:string)=>Promise<boolean>,private readonly connect?:((callbacks:QrConnectCallbacks,options:QrConnectOptions)=>()=>void)){}
  async start(reference:string):Promise<QQSetupState>{
    if(!CREDENTIAL_RE.test(reference)||await this.configured(reference))throw new Error('Choose an unused credential reference')
    // A settings panel owns one active scan; replacing it cancels the previous generation.
    await this.close()
    const id=randomUUID(),controller=new AbortController(),state:QQSetupState={id,phase:'waiting'}
    const entry:{state:QQSetupState;controller:AbortController;stop?:()=>void;task?:Promise<void>;expires:ReturnType<typeof setTimeout>}={state,controller,expires:setTimeout(()=>{void this.cancel(id)},5*60_000)}
    this.scans.set(id,entry)
    const current=()=>this.scans.get(id)===entry&&!controller.signal.aborted&&entry.state.phase==='waiting'
    const connect=this.connect??(await import('@tencent-connect/qqbot-connector')).startQrConnect
    if(!current())return {...entry.state}
    entry.stop=connect({
      onQrDisplayed:url=>{
        if(!current())return
        // Official connector only returns its own HTTPS binding URL. Validate before exposing a clickable link.
        const parsed=new URL(url)
        if(parsed.protocol!=='https:'||parsed.hostname!=='q.qq.com'){entry.state={id,phase:'failed'};controller.abort();return}
        entry.state={id,phase:'waiting',url}
        void renderQrSvgDataUrl(url).then(qrSvg=>{if(current())entry.state={...entry.state,qrSvg}},()=>{})
      },
      onSuccess:credentials=>{
        if(!current())return
        const value=credentials[0]
        entry.state={id,phase:'saving'}
        entry.task=this.finish(entry,value,reference).catch(()=>{entry.state={id,phase:'failed'}})
      },
      onFailure:()=>{if(current())entry.state={id,phase:'failed'}},
    },{source:'messaging-channels',signal:controller.signal,displayQrCodeToConsole:false})
    return {...entry.state}
  }
  private async finish(entry:{state:QQSetupState;controller:AbortController;expires:ReturnType<typeof setTimeout>},value:QrConnectCredentials|undefined,reference:string){
    if(!value||!/^[1-9]\d{3,31}$/.test(value.appId)||!value.appSecret||!value.userOpenid||!/^[A-Za-z0-9_-]{8,128}$/.test(value.userOpenid))throw new Error('Incomplete QQ credentials')
    if(entry.controller.signal.aborted)return
    await this.save(reference,value.appSecret)
    entry.state={id:entry.state.id,phase:'complete',appId:value.appId,ownerUserId:value.userOpenid,credentialRef:reference}
    clearTimeout(entry.expires)
  }
  status(id:string){return {...(this.scans.get(id)?.state??{id,phase:'cancelled' as const})}}
  async cancel(id:string){const entry=this.scans.get(id);if(!entry)return;entry.controller.abort();entry.stop?.();clearTimeout(entry.expires);await entry.task;if(entry.state.phase!=='complete')entry.state={id,phase:'cancelled'}}
  async close(){for(const id of this.scans.keys())await this.cancel(id);this.scans.clear()}
}
export class QQBotSetupController extends TypertRemoteService {
  static inject=['credentials']
  private readonly setup:QQBotSetup
  private readonly startedAt=new Date().toISOString()
  constructor(ctx:Context){
    super(ctx,'qqBotSetupController',{namespace:'qqBotSetup'})
    this.setup=new QQBotSetup((ref,value)=>ctx.credentials.set(credentialRef(ref),value),async ref=>(await ctx.credentials.describe(credentialRef(ref))).configured)
    ctx.effect(()=>()=>this.setup.close())
  }
  @Remote('start')
  start(reference:string):Promise<QQSetupState>{return this.setup.start(reference)}
  @Remote('status')
  status(id:string):QQSetupState{return this.setup.status(id)}
  @Remote('cancel')
  cancel(id:string):Promise<void>{return this.setup.cancel(id)}
  @Remote('runtime')
  runtime():{version:string;startedAt:string}{return {version:QQBOT_VERSION,startedAt:this.startedAt}}
  @Remote('credentialStatus')
  async credentialStatus(reference:string):Promise<{configured:boolean;writable:boolean;source?:string}>{
    if(!CREDENTIAL_RE.test(reference))throw new Error('Invalid credential reference')
    const {configured,writable,source}=await this.ctx.credentials.describe(credentialRef(reference))
    return {configured,writable,...(source?{source}:{})}
  }
  @Remote('saveCredential')
  async saveCredential(reference:string,value:string):Promise<void>{
    if(!/^QQBOT_[A-Za-z0-9_]+$/.test(reference)||!CREDENTIAL_RE.test(reference)||!value.trim()||value.length>4096)throw new Error('Invalid QQ credential')
    if((await this.ctx.credentials.describe(credentialRef(reference))).configured)throw new Error('Choose an unused reference; existing credentials were kept')
    await this.ctx.credentials.set(credentialRef(reference),value)
  }
}

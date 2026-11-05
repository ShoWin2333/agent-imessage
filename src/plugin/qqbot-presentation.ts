import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { formatToolResult } from '../channels/qqbot-official/tool-presenter.js'

export interface QQPresentationOptions {showToolResults?:boolean;sendPresentedFiles?:boolean;maxFiles?:number}
/** Agent-scoped native events only; no directory scanning or arbitrary target selection. */
export function installQQPresentation(ctx:Context,agent:Agent,options:QQPresentationOptions,input:{
  current:()=>boolean;notice:(text:string)=>void;
  deliver:(path:string,callId:string,exec:ToolExecution)=>Promise<void>;
}){
  const calls=new Map<string,{name:string;args:string}>()
  const seen=new Set<string>()
  let filesThisTurn=0
  const events=ctx.on('session/event',(session,event)=>{
    if(session!==agent.session||!input.current())return
    if(event.type==='tool/call')calls.set(event.data.callId,{name:event.data.name,args:event.data.arguments})
    if(event.type==='tool/result'){
      const id=event.data.message.source.callId,call=calls.get(id);calls.delete(id)
      if(call&&(event.data.error||options.showToolResults)){
        const text=formatToolResult(call.name,call.args,event.data,ctx.get('tools'),agent)
        if(text)input.notice(text)
      }
    }
    if(event.type==='turn/end'){calls.clear();seen.clear();filesThisTurn=0}
  })
  // Await delivery before the presenting tool completes. This keeps the native
  // turn and its shared approval alive; a detached turn-end upload would not.
  const execute=ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next()
    if(exec.agent!==agent||exec.name!=='present'||result.isError||decision.kind!=='accept'||options.sendPresentedFiles===false||!input.current()||exec.signal.aborted||seen.has(exec.callId))return decision
    // Current DSH's present emits its durable declaration only in tools/result,
    // after post-execute. Its validated canonical result is available here.
    const declaration='value' in decision?decision.value:result.value
    if(!declaration||typeof declaration!=='object'||Array.isArray(declaration)||!Array.isArray(declaration.files))return decision
    seen.add(exec.callId)
    for(const [index,file] of declaration.files.entries()){
      if(!file||typeof file!=='object'||Array.isArray(file)||typeof file.path!=='string')continue
      if(!input.current()||exec.signal.aborted)break
      if(filesThisTurn++ >= (options.maxFiles??4)){input.notice(`📎 ${file.path}：超出本轮交付上限，未发送。`);continue}
      try{await input.deliver(file.path,`present:${exec.callId}:${index}`,exec)}
      catch{input.notice(`📎 ${file.path}：未获批准、读取受限或投递未确认；文件仍保留在工作区，未自动重试。`)}
    }
    return decision
  })
  return()=>{events();execute();calls.clear();seen.clear()}
}
const escapeAttribute=(s:string)=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')
export const commandLink=(command:string,label:string)=>`<qqbot-cmd-input text="${escapeAttribute(command)}" show="${escapeAttribute(label)}"/>`

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { formatToolResult } from '../channels/qqbot-official/tool-presenter.js'

export interface QQPresentationOptions {showToolResults?:boolean;sendPresentedFiles?:boolean;maxFiles?:number}
/** Agent-scoped native events only; no directory scanning or arbitrary target selection. */
export function installQQPresentation(ctx:Context,agent:Agent,options:QQPresentationOptions,input:{
  current:()=>boolean;notice:(text:string)=>void;
}){
  const calls=new Map<string,{name:string;args:string}>()
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
    if(event.type==='turn/end')calls.clear()
  })
  return()=>{events();calls.clear()}
}

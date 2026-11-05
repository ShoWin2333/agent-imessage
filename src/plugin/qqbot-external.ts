import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {ChannelBridge,BindingState} from './bridge.js'
import type {ChannelAdapter} from '../channels/types.js'
import {textOf} from './native.js'
/** Non-QQ turns use the official proactive policy; receipts remain in the existing outbox. */
export function registerQQExternalTurns(ctx:Context,input:{state:()=>BindingState;bridge:ChannelBridge;adapter:ChannelAdapter;policy:'off'|'c2c';signal:AbortSignal}){
  return ctx.on('session/event',(session,event)=>{
    if(event.type!=='turn/end'||input.signal.aborted||session.id!==input.state().sessionId)return
    const events=session.snapshotEvents(),start=events.findLastIndex(e=>e.type==='turn/start'&&e.data.turn===event.data.turn)
    if(start<0)return
    const turn=events.slice(start),inputs=turn.filter((e):e is Extract<SessionEvent,{type:'user/message'}>=>e.type==='user/message')
    if(!inputs.length||inputs.some(e=>e.data.source.kind==='dsh-channels'))return
    const external=inputs.some(e=>e.data.source.kind==='user'&&(e.data.source as {form?:string}).form!=='notice')
    if(external&&input.policy==='off')return
    const text=turn.filter((e):e is Extract<SessionEvent,{type:'assistant/message'}>=>e.type==='assistant/message').map(e=>textOf(e.data.message.content)).join('')
    if(!text)return
    void (async()=>{
      if(!await ctx.sessions.flush(session)||input.signal.aborted||session.id!==input.state().sessionId)return
      const message=await input.adapter.scheduledMessage!(`qq-external:${session.id}:${event.data.turn}`,'')
      await input.bridge.deliverExternal(message,session.id,{text,reason:'completed'})
    })().catch(()=>{/* Native transcript and delivery receipts remain authoritative. */})
  },{global:true})
}

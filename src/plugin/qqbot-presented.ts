import type {Context} from '@deepseek-ai/cordis'
import type {ChannelBridge,BindingState} from './bridge.js'
import type {ChannelAdapter} from '../channels/types.js'
import type {QQPresentationOptions} from './qqbot-presentation.js'
import {loadOutboundMedia,DEFAULT_MAX_OUTBOUND_MEDIA_BYTES} from '../media.js'
/** Desktop/scheduled turns of the exact bound session share the same upload approval. */
export function registerQQPresented(ctx:Context,input:{state:()=>BindingState;bridge:ChannelBridge;adapter:ChannelAdapter;cwd:string;policy:'off'|'c2c';signal:AbortSignal;options:QQPresentationOptions}){
  let lastTurn='',fileCount=0
  return ctx.on('tools/post-execute',async(exec,result,next)=>{
    const decision=await next(),agent=exec.agent
    if(!agent||agent.id!==input.state().sessionId||agent.session.header.cwd!==input.cwd||ctx.agents.get(agent.id)!==agent||exec.name!=='present'||result.isError||decision.kind!=='accept'||input.options.sendPresentedFiles===false||input.signal.aborted)return decision
    const events=agent.session.snapshotEvents(),start=events.findLastIndex(e=>e.type==='turn/start'||e.type==='turn/end'),boundary=events[start]
    if(boundary?.type!=='turn/start')return decision
    const turn=boundary.data.turn,records=events.slice(start)
    const messages=records.filter(e=>e.type==='user/message')
    if(!messages.length||messages.some(e=>e.type==='user/message'&&e.data.source.kind==='dsh-channels'))return decision
    const desktop=messages.some(e=>e.type==='user/message'&&e.data.source.kind==='user'&&(e.data.source as {form?:string}).form!=='notice')
    if(desktop&&input.policy==='off')return decision
    const declaration='value' in decision?decision.value:result.value
    if(!declaration||typeof declaration!=='object'||Array.isArray(declaration)||!Array.isArray(declaration.files))return decision
    const signal=AbortSignal.any([exec.signal,input.signal]),current=()=>!signal.aborted&&agent.id===input.state().sessionId&&ctx.agents.get(agent.id)===agent&&(()=>{const latest=agent.session.snapshotEvents().findLast(e=>e.type==='turn/start'||e.type==='turn/end');return latest?.type==='turn/start'&&latest.data.turn===turn})()
    const turnKey=`${agent.id}:${turn}`;if(lastTurn!==turnKey){lastTurn=turnKey;fileCount=0}
    const message=await input.adapter.scheduledMessage!(`qq-present:${exec.callId}`,'')
    for(const [index,file] of declaration.files.entries()){
      if(!file||typeof file!=='object'||Array.isArray(file)||typeof file.path!=='string'||!current())continue
      const callId=`present:${exec.callId}:${index}`,receipt=input.state().receipts.find(r=>r.id===`qq-present:${agent.id}:${callId}`)
      if(receipt?.media?.length)continue
      if(fileCount++ >= (input.options.maxFiles??4)){await message.send(`📎 ${file.path}：超出本轮交付上限，未发送。`);continue}
      try{
        const approval=ctx.get('approval');if(!approval)throw new Error('Approval unavailable')
        const reason=`Upload file ${file.path} to this channel's configured recipient.`
        const outcome=await approval.request({agent,toolName:'channel_send_media',callId:exec.callId,reason,displayReason:{en:reason,zh:`将工作区中的文件「${file.path}」发送到当前 QQ 渠道。`},signal})
        if(outcome!=='allowed-once'||!current())throw new Error('Not approved')
        const reader=ctx.agentPresets.serviceFor(agent,'fs')??agent.ctx.get('fs');if(!reader)throw new Error('No filesystem')
        const media=await loadOutboundMedia({rawPath:file.path,kind:'file',workspaceCwd:input.cwd,maxBytes:DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,signal,reader})
        if(!await ctx.sessions.flush(agent.session)||!current())throw new Error('Not committed')
        const sent=await input.bridge.deliverExternalMedia(message,{sessionId:agent.id,inputId:`present:${exec.callId}`,turn,callId,kind:'file',media,signal,current})
        if(sent.delivery!=='sent')throw new Error('Uncertain')
      }catch{if(current())await message.send(`📎 ${file.path}：未获批准、读取受限或投递未确认；文件仍保留在工作区，未自动重试。`)}
    }
    return decision
  },{global:true})
}

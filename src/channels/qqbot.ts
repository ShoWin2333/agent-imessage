import { QQBot, errorHandler, messageFilter, accessPolicy, historyBuffer, MemoryHistoryStore, contentSanitizer, quoteRef, envelopeFormatter, typingIndicator, rateLimiter, type MiddlewareContext, type InlineKeyboard, type StreamSession } from '@tencent-connect/qqbot-nodejs'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import { silentLog, type ChannelLog } from '../shared/log.js'
import type { RuntimeView } from '../types.js'
import type { OutboundMediaPayload } from '../media.js'
import { chunkMarkdownText } from './qqbot-official/chunker.js'
import { ReplyLimiter } from './qqbot-official/reply-limiter.js'
import { cacheMsgId, cacheEventId } from './qqbot-official/msgid-cache.js'
import { resolveReplyTarget, sendResolvedMarkdown } from './qqbot-official/reply-target.js'
import type { ReplyTarget } from './qqbot-official/types.js'
import { receiveAttachments } from './qqbot-media.js'
import { QQBOT_VERSION } from '../shared/qqbot-version.js'
import { approvalStatus } from './approval.js'

export interface QQBotCredential {appId:string;appSecret:string;ownerUserId:string;streaming?:boolean;cwd:string}
const approval=/^\/(approve|deny) (a-[0-9a-f-]{36})$/
/** QQ is a transport: native Sessions, receipt recovery and shared approval remain owned by Channels. */
export class QQBotAdapter implements ChannelAdapter {
  state:RuntimeView={phase:'stopped'}
  private controller:AbortController|undefined
  private run:Promise<void>|undefined
  private bot:QQBot|undefined
  private readonly limiter=new ReplyLimiter({limit:4})
  private readonly streams=new Set<StreamSession>()
  constructor(private readonly credential:QQBotCredential,private readonly receive:(message:ChannelMessage)=>Promise<void>,private readonly changed:(state:RuntimeView)=>void,private readonly create:(options:ConstructorParameters<typeof QQBot>[0])=>QQBot=options=>new QQBot(options),private readonly log:ChannelLog=silentLog){}
  private publish(state:RuntimeView){this.state=state;this.changed(state)}
  async start(){
    if(this.controller)return
    const c=this.credential,controller=new AbortController();this.controller=controller
    this.publish({phase:'starting'})
    // Match the official DSH plugin's SDK configuration and middleware order.
    const bot=this.create({appId:c.appId,appSecret:c.appSecret,transport:'websocket',baseUrl:'https://api.bot.qq.com',tokenBaseUrl:'https://api.bot.qq.com',userAgent:'Messaging-Channels/QQBot qqbot-nodejs/1.0.5'})
    this.bot=bot
    bot.use(errorHandler({format:()=> 'QQ 处理未完成，请检查当前会话或配置后重试。'}))
    bot.use(messageFilter({skipSelfEcho:false}))
    bot.use(accessPolicy({c2c:{mode:'allowlist',allow:[c.ownerUserId]},group:{mode:'disabled',allow:[]}}))
    bot.use(async(ctx,next)=>{if(ctx.message.senderId!==c.ownerUserId)return;await next()})
    const history=new MemoryHistoryStore()
    bot.use(historyBuffer({limit:10,recordOnSkip:true,store:history}))
    bot.use(contentSanitizer({parseFaceTags:true}))
    bot.use(rateLimiter())
    bot.use(typingIndicator())
    bot.use(quoteRef({maxSize:500,preferMsgElements:true}))
    bot.use(envelopeFormatter({historyLimit:10,includeQuote:true,includeSender:true}))
    bot.on('message',async ctx=>{
      if(controller.signal.aborted||ctx.message.kind!=='c2c'||ctx.replyTarget.scope!=='c2c'||ctx.replyTarget.targetId!==c.ownerUserId)return
      const m=ctx.message
      const target:ReplyTarget={scope:'c2c',targetId:c.ownerUserId,...(ctx.replyTarget.msgId?{msgId:ctx.replyTarget.msgId}:{})}
      cacheMsgId('c2c',c.ownerUserId,ctx.replyTarget.msgId)
      const message=this.message(`qqbot:${m.messageId}`,m.content,target)
      if(m.content.trim()==='/bot-ping'){await message.send(`pong · ${Date.now()-ctx.receivedAt}ms`);return}
      if(m.content.trim()==='/bot-version'){await message.send(`Messaging Channels ${QQBOT_VERSION} · Tencent qqbot-nodejs 1.0.5 · reference dsh-qqbot 0.5.5`);return}
      if(m.content.trim()==='/bot-me'){await message.send(`User OpenID: ${m.senderId}`);return}
      // Preserve exact slash commands and approval credentials; envelopes are task content only.
      if(!/^\/(approve|deny|answer|new|reset|clear|compact|model|preset|stop|cancel|status|help|bot-status|bot-help|bot-settings)(?:\s|$)/.test(m.content.trim()))message.text=await this.body(ctx,controller.signal)
      if(message.text.trim())await this.receive(message)
    })
    bot.on('interaction',async(_ctx,event)=>{
      const data=event.data?.resolved?.button_data??''
      const valid=!controller.signal.aborted&&!event.group_openid&&!event.guild_id&&!event.channel_id&&event.scene!=='group'&&event.user_openid===c.ownerUserId&&approval.test(data)
      if(!valid){await bot.acknowledgeInteraction(event.id,3);return}
      cacheEventId('c2c',c.ownerUserId,event.id)
      let acknowledged=false
      const message=this.message(`qqbot-interaction:${event.id}`,data,{scope:'c2c',targetId:c.ownerUserId})
      message.acknowledgeDecision=async accepted=>{
        if(acknowledged)return
        acknowledged=true
        await bot.acknowledgeInteraction(event.id,accepted?0:3)
      }
      // Only the shared broker can validate an unexpired, delivered request.
      // Its acknowledgment runs before outbound confirmation messages.
      try{await this.receive(message)}finally{if(!acknowledged)await message.acknowledgeDecision(false)}
    })
    const ready=()=>{if(!controller.signal.aborted)this.publish({phase:'listening',connectedAt:Date.now()})}
    bot.on('ready',ready);bot.on('resumed',ready)
    bot.on('disconnected',event=>{
      if(controller.signal.aborted)return
      this.publish(event.willReconnect?{phase:'retrying',attempt:1,retryAt:Date.now()}:{phase:'failed',error:{code:'runtime-failed',message:'QQ 连接已停止，请检查机器人授权后重试。'}})
    })
    bot.on('error',error=>{/* SDK's run promise and disconnect events own lifecycle; credentials never reach this sink. */this.log('qqbot-sdk-error',error)})
    this.run=bot.start(controller.signal).catch(()=>{if(!controller.signal.aborted)this.publish({phase:'failed',error:{code:'runtime-failed',message:'QQ 连接失败，请检查 AppID、凭据与平台权限。'}})})
  }
  async stop(){
    this.controller?.abort();this.controller=undefined
    for(const stream of this.streams)stream.cancel()
    this.streams.clear();this.bot?.stop();await this.run;this.bot=undefined
    this.publish({phase:'stopped'})
  }
  private async body(ctx:MiddlewareContext,signal:AbortSignal){
    const parts=[ctx.state.envelope||ctx.message.content]
    const attachments=ctx.message.attachments??[]
    const quoted=ctx.state.quote?.attachments??[]
    const raw=[...attachments,...quoted.map(a=>({content_type:a.contentType??'',filename:a.filename??'attachment',url:a.url??'',size:0,asr_refer_text:a.asrText}))]
    parts.push(...await receiveAttachments(raw,this.credential.cwd,signal))
    return parts.filter(Boolean).join('\n\n')
  }
  async approvalMessage(){
    if(this.state.phase!=='listening')throw new Error('QQ is not connected')
    const c=this.credential
    return this.message('approval','',{scope:'c2c',targetId:c.ownerUserId})
  }
  async scheduledMessage(id:string,text:string){
    if(this.state.phase!=='listening')throw new Error('QQ is not connected')
    const c=this.credential
    return this.message(id,text,{scope:'c2c',targetId:c.ownerUserId},true)
  }
  private message(id:string,text:string,target:ReplyTarget,proactive=false):ChannelMessage{
    const bot=this.bot!,signal=this.controller!.signal,c=this.credential
    const resolved=(events=true)=>{signal.throwIfAborted();return resolveReplyTarget({...target,...(proactive?{forceProactive:true}:{})},this.limiter,events)}
    let stream:StreamSession|undefined,streamTail=Promise.resolve(),streamError:unknown,staticOnly=false
    const send=async(value:string,keyboard?:InlineKeyboard)=>{
      const parts=chunkMarkdownText(value,4500)
      for(let i=0;i<parts.length;i++)await sendResolvedMarkdown(bot,resolved(),parts[i]!,i===parts.length-1&&keyboard?{keyboard}:undefined)
    }
    const media=async(kind:'image'|'file'|'voice',payload:OutboundMediaPayload,cancellation?:AbortSignal)=>{
      cancellation?.throwIfAborted();signal.throwIfAborted()
      const r=resolved(false),destination={scope:r.scope,targetId:r.targetId,...(r.msgId?{msgId:r.msgId}:{})},source={buffer:payload.bytes}
      if(kind==='image')await bot.sendImage(destination,source)
      else if(kind==='voice')await bot.sendVoice(destination,source)
      else if(payload.mimeType.startsWith('video/')||/\.(mp4|mov|avi|mkv|webm)$/i.test(payload.name))await bot.sendVideo(destination,source)
      else await bot.sendFile(destination,source,{fileName:payload.name})
    }
    const message:ChannelMessage={id,text,commandChannel:'qqbot',nativeVoice:true,
      supportsNativeVoice:payload=>/\.(silk|mp3|wav)$/i.test(payload.name),
      send:value=>send(value),sendImage:(m,s)=>media('image',m,s),sendFile:(m,s)=>media('file',m,s),sendVoice:(m,s)=>media('voice',m,s),
      responding:async callback=>callback(),
      sendApproval:async(value,token,cancellation)=>{
        cancellation.throwIfAborted()
        // Match Tencent's platform button permission. Authorizing a decision
        // remains server-side: fixed owner, destination and one-time token.
        // QQ may display visited_label on tap, before Host acceptance. It must
        // describe submission, never invent an authorization on an expired card.
        const button=(verb:'approve'|'deny',label:string)=>({id:verb,render_data:{label,visited_label:'已提交，请看结果',style:verb==='approve'?1:0},action:{type:1,permission:{type:2},data:`/${verb} ${token}`,click_limit:1},group_id:'approval'})
        const reference=token.slice(-8)
        await send(`${value}\n\n审批编号：${reference}\n点击仅提交决定，最终以 DSH 审批结果为准。`,{content:{rows:[{buttons:[button('approve','批准一次'),button('deny','拒绝')]}]}})
        return async outcome=>{if(!signal.aborted)await send(`DSH 审批 ${reference}：${approvalStatus(outcome)}。${outcome==='expired'?'本卡片已失效，没有通过此卡片执行授权。':''}`)}
      },
    }
    if(c.streaming!==false&&target.msgId&&!proactive){
      message.progressText=fullText=>{
        streamTail=streamTail.then(async()=>{
          signal.throwIfAborted()
          if(streamError)throw streamError
          if(staticOnly)return
          if(!stream){
            const r=resolved(false)
            // SDK streams require a passive message ID. No frame has been sent,
            // so an exhausted/expired reply window can safely use one static send.
            if(!r.msgId){staticOnly=true;return}
            stream=bot.openStream({target:{scope:r.scope,targetId:r.targetId,msgId:r.msgId}});this.streams.add(stream)
          }
          await stream.update(fullText)
        }).catch(error=>{streamError=error})
        return streamTail
      }
      message.completeText=async fullText=>{
        await message.progressText!(fullText);await streamTail
        try{if(streamError)throw streamError;if(staticOnly)await send(fullText);else await stream!.complete()}
        finally{if(stream){stream.cancel();this.streams.delete(stream)}}
      }
    }
    return message
  }
}

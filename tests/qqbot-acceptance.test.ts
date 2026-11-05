import {describe,it,expect,vi} from 'vitest'
import {QQBot,runMiddlewareChain,type Middleware,type QQBotInboundMessage} from '@tencent-connect/qqbot-nodejs'
import {QQBotAdapter} from '../src/channels/qqbot.js'
import {QQBotSetup} from '../src/plugin/qqbot-setup.js'
import type {QrConnectCallbacks} from '@tencent-connect/qqbot-connector'
import {ChannelBridge,type BindingState,type NativeSession} from '../src/plugin/bridge.js'
import type {ChannelMessage} from '../src/channels/types.js'
function harness(ownerUserId='owner_openid'){
  const events=new Map<string,Function>(),middlewares:Middleware[]=[],receive=vi.fn(async()=>{}),changed=vi.fn()
  let finish!:()=>void
  const stream={update:vi.fn(async()=>{}),complete:vi.fn(async()=>{}),cancel:vi.fn()}
  const bot={appId:'12345678',accountId:'12345678',use:vi.fn((m:Middleware)=>middlewares.push(m)),on:vi.fn((e:string,h:Function)=>events.set(e,h)),start:vi.fn(()=>new Promise<void>(r=>{finish=r})),stop:vi.fn(()=>finish()),sendMarkdown:vi.fn(async()=>({id:'outbound'})),send:vi.fn(async()=>({id:'outbound'})),sendImage:vi.fn(async()=>({})),sendVideo:vi.fn(async()=>({})),sendVoice:vi.fn(async()=>({})),sendFile:vi.fn(async()=>({})),sendTyping:vi.fn(async()=>({})),acknowledgeInteraction:vi.fn(async()=>{}),openStream:vi.fn(()=>stream)}
  const adapter=new QQBotAdapter({appId:'12345678',appSecret:'synthetic-qq-secret',ownerUserId,cwd:'/tmp'},receive,changed,()=>bot as unknown as QQBot)
  const ingest=async(content:string,extra:Record<string,unknown>={})=>{
    const message={kind:'c2c',rawEventType:'C2C_MESSAGE_CREATE',senderId:ownerUserId,messageId:crypto.randomUUID(),content,timestamp:new Date().toISOString(),replyTarget:{scope:'c2c',targetId:ownerUserId,msgId:crypto.randomUUID()},...extra} as QQBotInboundMessage
    const controller=new AbortController()
    const ctx:any={bot,message,replyTarget:message.replyTarget,state:{},receivedAt:Date.now(),signal:controller.signal,stopped:false,aborted:false,log:{debug:vi.fn(),info:vi.fn(),warn:vi.fn(),error:vi.fn()},stop(){this.stopped=true},abort(){this.aborted=true;this.stopped=true;controller.abort()}}
    if(await runMiddlewareChain(middlewares,ctx))await events.get('message')!(ctx)
    return ctx
  }
  return {adapter,bot,stream,events,receive,changed,ingest}
}
describe('official SDK transport acceptance, offline',()=>{
  it('admits only the configured owner; uses passive Markdown and native media; schedules proactively',async()=>{
    const f=harness();await f.adapter.start();f.events.get('ready')!()
    await f.ingest('untrusted',{senderId:'stranger_openid'});expect(f.receive).not.toHaveBeenCalled()
    const ctx=await f.ingest('hello')
    const message=f.receive.mock.calls[0]![0] as unknown as ChannelMessage
    await message.send('answer')
    expect(f.bot.sendMarkdown).toHaveBeenLastCalledWith(expect.objectContaining({msgId:ctx.replyTarget.msgId}), 'answer',undefined)
    const media={name:'report.pdf',mimeType:'application/pdf',bytes:Buffer.from('fixture')}
    await message.sendFile(media);expect(f.bot.sendFile).toHaveBeenCalledWith(expect.objectContaining({scope:'c2c'}),{buffer:media.bytes},{fileName:'report.pdf'})
    await message.sendImage({...media,name:'image.png',mimeType:'image/png'});await message.sendVoice({...media,name:'voice.silk',mimeType:'audio/silk'})
    await message.sendFile({...media,name:'clip.mp4',mimeType:'video/mp4'})
    expect(f.bot.sendImage).toHaveBeenCalledOnce();expect(f.bot.sendVoice).toHaveBeenCalledOnce();expect(f.bot.sendVideo).toHaveBeenCalledOnce()
    await(await f.adapter.scheduledMessage('schedule','')).send('timer')
    expect(f.bot.sendMarkdown.mock.calls.at(-1)?.[0]).not.toHaveProperty('msgId')
    await f.adapter.stop();expect(f.bot.stop).toHaveBeenCalledOnce();expect(f.adapter.state.phase).toBe('stopped')
  })
  it('rejects all group messages and callbacks, including those from the configured owner',async()=>{
    const f=harness();await f.adapter.start();f.events.get('ready')!()
    await f.ingest('group task',{kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',groupOpenid:'group_openid',replyTarget:{scope:'group',targetId:'group_openid'}})
    expect(f.receive).not.toHaveBeenCalled();expect(f.bot.sendMarkdown).not.toHaveBeenCalled()
    await f.ingest('private task');expect(f.receive).toHaveBeenCalledOnce()
    await f.events.get('interaction')!({},{id:'group-click',scene:'group',user_openid:'owner_openid',group_member_openid:'owner_openid',group_openid:'group_openid',data:{resolved:{button_data:'/approve a-12345678-1234-1234-1234-123456789012'}}})
    expect(f.bot.acknowledgeInteraction).toHaveBeenLastCalledWith('group-click',3);expect(f.receive).toHaveBeenCalledOnce()
    await (await f.adapter.approvalMessage()).send('private approval')
    expect(f.bot.sendMarkdown.mock.calls.at(-1)?.[0]).toMatchObject({scope:'c2c',targetId:'owner_openid'})
    await f.adapter.stop()
  })
  it('turns buttons into existing one-time commands only for the fixed owner and destination',async()=>{
    const f=harness();await f.adapter.start();f.events.get('ready')!();await f.ingest('task')
    const message=f.receive.mock.calls[0]![0] as unknown as ChannelMessage,token='a-12345678-1234-1234-1234-123456789012'
    await message.sendApproval!('existing approval prompt',token,new AbortController().signal)
    const keyboard=f.bot.sendMarkdown.mock.calls.at(-1)?.[2]
    // QQ renders the visited state and disables siblings in the same group,
    // matching Tencent's official DSH approval keyboard without changing policy.
    expect(keyboard).toMatchObject({keyboard:{content:{rows:[{buttons:[
      {render_data:{label:'批准一次',visited_label:'已提交，请看结果'},group_id:'approval',action:{type:1,data:`/approve ${token}`}},
      {render_data:{label:'拒绝',visited_label:'已提交，请看结果'},group_id:'approval',action:{type:1,data:`/deny ${token}`}},
    ]}]}}})
    const event={id:'interaction-1',scene:'c2c',user_openid:'stranger_openid',data:{resolved:{button_data:`/approve ${token}`}}}
    await f.events.get('interaction')!({},event);expect(f.receive).toHaveBeenCalledOnce()
    f.receive.mockImplementationOnce(async message=>{expect(f.bot.acknowledgeInteraction).not.toHaveBeenCalledWith('interaction-2',0);await (message as ChannelMessage).acknowledgeDecision!(true)})
    await f.events.get('interaction')!({},{...event,id:'interaction-2',user_openid:'owner_openid'})
    expect(f.receive.mock.calls.at(-1)?.[0]).toMatchObject({text:`/approve ${token}`})
    await f.adapter.stop()
  })
  it('keeps explicit commands intact and completes SDK streaming without a duplicate static reply',async()=>{
    const f=harness();await f.adapter.start();f.events.get('ready')!();await f.ingest('/model synthetic/test')
    const m=f.receive.mock.calls[0]![0] as unknown as ChannelMessage
    expect(m.text).toBe('/model synthetic/test');await m.progressText!('partial');await m.completeText!('final')
    expect(f.stream.complete).toHaveBeenCalledOnce();expect(f.bot.sendMarkdown).not.toHaveBeenCalled()
    await f.adapter.stop()
  })
})
it('QR binding retains secret in host only, handles success and cancelled late callbacks',async()=>{
  let callbacks!:QrConnectCallbacks
  const save=vi.fn(async()=>{}),stop=vi.fn(),configured=vi.fn(async()=>false)
  const setup=new QQBotSetup(save,configured,(next)=>{callbacks=next;return stop})
  const initial=await setup.start('QQBOT_SYNTHETIC')
  callbacks.onQrDisplayed!('https://q.qq.com/qqbot/connect.html?fixture=1')
  callbacks.onSuccess([{appId:'12345678',appSecret:'synthetic-secret',userOpenid:'owner_openid'}])
  await vi.waitFor(()=>expect(setup.status(initial.id).phase).toBe('complete'))
  expect(save).toHaveBeenCalledWith('QQBOT_SYNTHETIC','synthetic-secret')
  expect(JSON.stringify(setup.status(initial.id))).not.toContain('synthetic-secret')
  const next=await setup.start('QQBOT_CANCELLED');await setup.cancel(next.id)
  callbacks.onSuccess([{appId:'12345678',appSecret:'never-store',userOpenid:'owner_openid'}])
  expect(save).toHaveBeenCalledOnce();await setup.close()
})
it('records stream delivery before first external frame and quarantines a broken stream',async()=>{
  let state:BindingState={receipts:[]},stream!:((text:string)=>void)
  let finish!:(result:{text:string;reason:string})=>void
  const session:NativeSession={id:'channels-synthetic',cancel:vi.fn(),close:vi.fn(async()=>{}),submit:(_id,_text,_progress,_interaction,_media,send)=>{stream=send!;return {admitted:Promise.resolve(),result:new Promise(r=>finish=r)}}}
  const bridge=new ChannelBridge({open:async()=>session,inspect:async()=>undefined},{read:()=>state,write:async value=>{state=value}})
  const message:ChannelMessage={id:'input-stream',text:'task',responding:async f=>f(),send:vi.fn(async()=>{}),sendFile:vi.fn(async()=>{}),sendVoice:vi.fn(async()=>{}),progressText:vi.fn(async()=>{expect(state.receipts[0]?.delivery).toBe('sending');throw new Error('ambiguous provider error')}),completeText:vi.fn(async()=>{})}
  await bridge.receive(message);stream('partial');finish({text:'final',reason:'completed'});await bridge.drain()
  expect(state.receipts[0]?.delivery).toBe('uncertain');expect(message.send).not.toHaveBeenCalled();expect(message.completeText).not.toHaveBeenCalled();await bridge.close()
})
it('uses the published DSH 0.2.2 model.select API without changing approval policy',async()=>{
  const {QQCommands}=await import('../src/plugin/qqbot-commands.js')
  const {Session,SessionId}=await import('@deepseek-ai/dsh-session')
  const session=Session.create(SessionId('channels-binding-synthetic')),select=vi.fn(),policy=vi.fn()
  const agent={id:session.id,session,model:{current:()=>({provider:'synthetic',model:'first'}),select}}
  const ctx={agents:{get:()=>agent},llm:{listModels:async()=>[{id:'first'},{id:'second'}]},sessions:{flush:async()=>true},permissionPresets:{set:policy}} as any
  const host=new QQCommands(ctx,{binding:'binding',options:{}})
  expect(await host.command('/model synthetic/second',session.id,{})).toMatchObject({preferences:{model:{provider:'synthetic',model:'second'}}})
  expect(select).toHaveBeenCalledWith({provider:'synthetic',model:'second'});expect(policy).not.toHaveBeenCalled()
  expect(await host.command('/model synthetic/missing',session.id,{})).toMatchObject({text:'模型不在宿主目录中。'})
  expect(select).toHaveBeenCalledOnce()
})
it('retains official image-understanding behavior through composed fs, attachments and host LLM',async()=>{
  const {describeQQImage}=await import('../src/plugin/qqbot-tools.js')
  const bytes=Buffer.from('89504e470d0a1a0a00000000','hex'),saved=vi.fn(async()=>({id:'image-fixture',mediaType:'image/png',name:'image.png',width:1,height:1,bytes:bytes.length} as any))
  const reader={resolve:async(p:string)=>({displayPath:p}),processPath:(p:any)=>p.displayPath,contains:()=>true,stat:async()=>({type:'file' as const,size:bytes.length}),readBytes:async()=>bytes}
  const stream=vi.fn(async function* (options:any){expect(options.messages[0].content[0]).toMatchObject({type:'image',attachment:{id:'image-fixture'}});yield {type:'text-delta',index:0,text:'OCR result'} as any})
  expect(await describeQQImage({image:'/workspace/image.png',prompt:'read text',cwd:'/workspace',reader,signal:new AbortController().signal,provider:'synthetic',model:'vision',attachments:{saveImage:saved},llm:{stream}})).toEqual({text:'OCR result'})
  expect(saved).toHaveBeenCalledWith(expect.objectContaining({mediaType:'image/png',data:bytes}));expect(stream).toHaveBeenCalledOnce()
})
it('delivers desktop turns proactively through the durable outbox exactly once',async()=>{
  const {registerQQExternalTurns}=await import('../src/plugin/qqbot-external.js')
  const {Session,SessionId}=await import('@deepseek-ai/dsh-session')
  const {createUserMessage}=await import('@deepseek-ai/dsh-llm')
  const session=Session.create(SessionId('channels-external-fixture'))
  session.append('turn/start',{turn:1});session.append('user/message',createUserMessage({content:[{type:'text',text:'desktop input'}],source:{kind:'user'}}),{surfaceOp:'append'});session.append('assistant/message',{turn:1,message:{content:[{type:'text',text:'desktop answer'}]}} as any,{surfaceOp:'append'})
  const end={type:'turn/end',data:{turn:1,reason:{kind:'completed'}}} as any
  let state:BindingState={sessionId:session.id,receipts:[]},handler!:Function
  const send=vi.fn(async()=>{}),destination={id:'outbound',text:'',send,responding:async(f:any)=>f(),sendFile:vi.fn(),sendVoice:vi.fn()} as ChannelMessage
  const bridge=new ChannelBridge({open:vi.fn(),inspect:async()=>undefined},{read:()=>state,write:async value=>{state=value}})
  const ctx={on:vi.fn((_event:string,fn:Function)=>{handler=fn;return ()=>{}}),sessions:{flush:vi.fn(async()=>true)}} as any
  const adapter={scheduledMessage:vi.fn(async(id:string)=>({...destination,id}))} as any
  registerQQExternalTurns(ctx,{state:()=>state,bridge,adapter,policy:'c2c',signal:new AbortController().signal})
  handler(session,end);await vi.waitFor(()=>expect(send).toHaveBeenCalledWith('desktop answer'))
  handler(session,end);await new Promise(resolve=>setTimeout(resolve,5));expect(send).toHaveBeenCalledOnce()
  expect(state.receipts[0]).toMatchObject({delivery:'sent'});expect(ctx.on.mock.calls[0]?.[2]).toEqual({global:true});await bridge.close()
})

it('real Tencent SDK preserves official button permissions, visited labels and exclusive groups in the HTTP body',async()=>{
  const fetch=vi.fn(async(url:string|URL|Request)=>new Response(JSON.stringify(String(url).includes('getAppAccessToken')?{access_token:'synthetic-access-token',expires_in:7200}:{id:'synthetic-sent'}),{status:200,headers:{'content-type':'application/json'}}))
  vi.stubGlobal('fetch',fetch)
  try{
    const f=harness();await f.adapter.start();f.events.get('ready')!();await f.ingest('task')
    const m=f.receive.mock.calls[0]![0] as unknown as ChannelMessage
    await m.sendApproval!('approval','a-12345678-1234-1234-1234-123456789012',new AbortController().signal)
    const keyboard=f.bot.sendMarkdown.mock.calls.at(-1)?.[2]
    const sdk=new QQBot({appId:'12345678',appSecret:'synthetic-only'})
    await sdk.sendMarkdown({scope:'c2c',targetId:'owner_openid'},'approval',keyboard)
    const request=fetch.mock.calls.find(c=>String(c[0]).includes('/messages')) as any
    const body=JSON.parse(request[1].body)
    expect(body.keyboard.content.rows[0].buttons).toMatchObject([
      {group_id:'approval',render_data:{visited_label:'已提交，请看结果'},action:{permission:{type:2}}},
      {group_id:'approval',render_data:{visited_label:'已提交，请看结果'}},
    ])
    expect(body.keyboard.content.rows[0].buttons[0].action.permission).not.toHaveProperty('specify_user_ids')
    await f.adapter.stop()
  }finally{vi.unstubAllGlobals()}
})

it.each([false,true])('acknowledges only a live consumed approval; expired=%s never grants or claims permission',async expired=>{
  vi.useFakeTimers()
  const f=harness(),state:BindingState={sessionId:'approval-session',receipts:[]},host={open:vi.fn(),inspect:vi.fn()},bridge=new ChannelBridge(host as any,{read:()=>state,write:async value=>{Object.assign(state,value)}})
  const final=Promise.withResolvers<any>()
  try{
    f.receive.mockImplementation(async message=>bridge.receive(message as unknown as ChannelMessage))
    await f.adapter.start();f.events.get('ready')!()
    const request=bridge.approveShared({sessionId:'approval-session',turn:1,toolName:'channel_send_media',reason:'Synthetic image',signal:new AbortController().signal,current:()=>true} as any,()=>f.adapter.approvalMessage(),final.promise)
    await vi.advanceTimersByTimeAsync(0)
    const keyboard=(f.bot.sendMarkdown.mock.calls[0]?.[2] as any)?.keyboard??(f.bot.send.mock.calls[0]?.[0] as any)?.keyboard,data=keyboard.content.rows[0].buttons[0].action.data
    expect(keyboard.content.rows[0].buttons[0].render_data.visited_label).not.toMatch(/已允许|已批准/)
    if(expired){await vi.advanceTimersByTimeAsync(120001);expect(await request).toBe('unavailable')}
    const event={id:expired?'expired-click':'live-click',scene:'c2c',user_openid:'owner_openid',data:{resolved:{button_data:data}}}
    await f.events.get('interaction')!({},event)
    expect(f.bot.acknowledgeInteraction).toHaveBeenLastCalledWith(event.id,expired?3:0)
    if(!expired){expect(await request).toBe('allowed-once');final.resolve('allowed-once');await vi.advanceTimersByTimeAsync(0)}
    else expect(state.receipts.at(-1)?.result?.text).toContain('没有执行任何授权')
    const sent=JSON.stringify([...f.bot.sendMarkdown.mock.calls,...f.bot.send.mock.calls])
    expect(sent).not.toContain('：expired')
    expect(sent).toContain(expired?'本卡片已失效':'已批准一次')
    expect(host.open).not.toHaveBeenCalled();expect(f.bot.sendImage).not.toHaveBeenCalled()
    await f.events.get('interaction')!({},{...event,id:'repeat-click'})
    expect(f.bot.acknowledgeInteraction).toHaveBeenLastCalledWith('repeat-click',3)
  }finally{bridge.setConnected(false);await f.adapter.stop();await bridge.close();vi.useRealTimers()}
})

it.each(['exhausted','expired'])('delivers the final answer statically before any stream frame when passive IDs are %s',async mode=>{
  const f=harness(`stream_${mode}_${crypto.randomUUID()}`)
  let clock:ReturnType<typeof vi.spyOn>|undefined
  try{
    await f.adapter.start();f.events.get('ready')!();await f.ingest('task')
    const message=f.receive.mock.calls[0]![0] as unknown as ChannelMessage
    if(mode==='exhausted')for(let i=0;i<4;i++)await message.send(`tool notice ${i}`)
    else {const later=Date.now()+31*60*1000;clock=vi.spyOn(Date,'now').mockReturnValue(later)}
    const session:NativeSession={id:'channels-stream-fallback',cancel(){},close:async()=>{},submit:(_id,_text,_progress,_interactions,_media,stream)=>{
      stream!('partial');stream!('final answer')
      return {admitted:Promise.resolve(),result:Promise.resolve({text:'final answer',reason:'completed'})}
    }}
    let state:BindingState={receipts:[]}
    const bridge=new ChannelBridge({open:async()=>session,inspect:async()=>undefined},{read:()=>state,write:async value=>{state=value}})
    await bridge.receive(message);await bridge.drain()
    expect(f.bot.openStream).not.toHaveBeenCalled();expect(f.bot.sendMarkdown).toHaveBeenLastCalledWith({scope:'c2c',targetId:expect.any(String)},'final answer',undefined)
    expect(f.bot.sendMarkdown.mock.calls.filter(c=>c[1]==='final answer')).toHaveLength(1)
    expect(state.receipts[0]?.delivery).toBe('sent');await bridge.close()
  }finally{clock?.mockRestore();await f.adapter.stop()}
})
it('never falls back to static delivery after a stream update becomes uncertain',async()=>{
  const f=harness(`stream_uncertain_${crypto.randomUUID()}`)
  await f.adapter.start();f.events.get('ready')!();await f.ingest('task')
  const message=f.receive.mock.calls[0]![0] as unknown as ChannelMessage
  f.stream.update.mockRejectedValueOnce(new Error('ambiguous send'))
  await message.progressText!('partial');await expect(message.completeText!('final')).rejects.toThrow('ambiguous send')
  expect(f.bot.openStream).toHaveBeenCalledOnce();expect(f.bot.sendMarkdown).not.toHaveBeenCalled();await f.adapter.stop()
})

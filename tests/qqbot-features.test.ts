import {it,expect,vi} from 'vitest'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {registerQQPresented} from '../src/plugin/qqbot-presented.js'
import {DshNativeHost} from '../src/plugin/native.js'
import {QQBotSetupController} from '../src/plugin/qqbot-setup.js'
import {installQQPresentation} from '../src/plugin/qqbot-presentation.js'

function external(){
  const session=Session.create(SessionId('qq-owned'),[],{...Session.create(SessionId('qq-owned')).header,cwd:'/workspace'})
  session.append('turn/start',{turn:1});session.append('user/message',createUserMessage({content:[{type:'text',text:'task'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const reader={resolve:vi.fn(async()=>({targetKey:'file',displayPath:'/workspace/report.pdf'})),processPath:()=>'/workspace/report.pdf',contains:()=>true,stat:async()=>({type:'file',size:4}),readBytes:vi.fn(async()=>Buffer.from('test'))}
  const request=vi.fn(async()=> 'allowed-once'),send=vi.fn(async()=>{}),deliver=vi.fn(async()=>({delivery:'sent'})),agent={id:session.id,session},signal=new AbortController()
  let listener:any
  const ctx={on:vi.fn((_event:string,fn:any)=>{listener=fn;return()=>{}}),agents:{get:()=>agent},agentPresets:{serviceFor:()=>reader},get:()=>({request}),sessions:{flush:vi.fn(async()=>true)}} as any
  const state={sessionId:session.id,receipts:[] as any[]},adapter={scheduledMessage:vi.fn(async()=>({send}))} as any
  registerQQPresented(ctx,{state:()=>state,bridge:{deliverExternalMedia:deliver} as any,adapter,cwd:'/workspace',policy:'c2c',signal:signal.signal,options:{maxFiles:4}})
  const exec={agent,name:'present',callId:'present-call',signal:signal.signal},result={isError:false,value:{turn:1,files:[{path:'report.pdf'}]},content:[]}
  const run=(e=exec,r=result,decision:any={kind:'accept'})=>listener(e,r,async()=>decision)
  return {run,exec,result,request,reader,deliver,state,session,send,signal}
}
it('delivers a desktop present only to its exact bound QQ session after approval and composed reads',async()=>{
  const f=external();f.request.mockImplementationOnce(async()=>{expect(f.reader.readBytes).not.toHaveBeenCalled();return 'allowed-once'})
  await f.run();expect(f.deliver).toHaveBeenCalledOnce();expect(f.deliver.mock.calls[0]![1]).toMatchObject({sessionId:'qq-owned',kind:'file',callId:'present:present-call:0'})
  await f.run({...f.exec,agent:{...f.exec.agent,id:'foreign'}} as any);expect(f.request).toHaveBeenCalledOnce()
  await f.run(f.exec,f.result,{kind:'block',feedback:[]});expect(f.request).toHaveBeenCalledOnce()
})
it('never reads or sends rejected, already journaled or ended-turn deliverables',async()=>{
  const f=external();f.request.mockResolvedValue('rejected');await f.run();expect(f.reader.readBytes).not.toHaveBeenCalled();expect(f.deliver).not.toHaveBeenCalled()
  f.state.receipts.push({id:'qq-present:qq-owned:present:present-call:0',media:[{delivery:'uncertain'}]});await f.run();expect(f.request).toHaveBeenCalledOnce()
  f.state.receipts=[];f.session.append('turn/end',{turn:1,reason:{kind:'completed'}});await f.run();expect(f.request).toHaveBeenCalledOnce()
})
it('lists clickable host models and reports settings without creating an agent or reading credentials',async()=>{
  const create=vi.fn(),ctx={agents:{get:()=>undefined,create},llm:{listProviders:async()=>[{id:'test'}],listModels:async()=>[{id:'model',name:'A"<B'}]},agentDefaultModel:{currentSelection:()=>({provider:'test',model:'model'})},agentPresets:{defaultId:'preset'}} as any
  const host=new DshNativeHost(ctx,'/workspace','workspace-write','binding')
  expect((await host.command('/model',undefined,{})).text).toContain('text="/model test/model" show="A&quot;&lt;B"')
  expect((await host.command('/bot-settings',undefined,{})).text).toContain('每份仍需审批')
  expect((await host.command('/bot-status',undefined,{})).text).toContain('test/model');expect(create).not.toHaveBeenCalled()
})
it('manual credentials reject existing references and never return a secret',async()=>{
  const credentials={describe:vi.fn(async()=>({configured:false,writable:true})),set:vi.fn(async()=>{})},service={ctx:{credentials}} as any
  expect(await QQBotSetupController.prototype.saveCredential.call(service,'QQBOT_NEW','synthetic-secret')).toBeUndefined()
  expect(credentials.set).toHaveBeenCalledWith('QQBOT_NEW','synthetic-secret')
  credentials.describe.mockResolvedValue({configured:true,writable:true})
  await expect(QQBotSetupController.prototype.saveCredential.call(service,'QQBOT_NEW','other-secret')).rejects.toThrow('existing credentials were kept')
  expect(credentials.set).toHaveBeenCalledOnce()
})
it('shows tool errors only for the current agent, while successful results obey the setting',()=>{
  const handlers=new Map<string,Function>(),notice=vi.fn(),session={},agent={session} as any
  const ctx={on:(event:string,fn:Function)=>{handlers.set(event,fn);return()=>{}},get:()=>undefined} as any
  const release=installQQPresentation(ctx,agent,{showToolResults:false},{current:()=>true,notice,deliver:vi.fn()})
  const event=handlers.get('session/event')!,call={type:'tool/call',data:{callId:'c',name:'terminal',arguments:'{}'}},result={type:'tool/result',data:{message:{source:{callId:'c'},content:[]},error:{name:'Denied',code:'FS_POLICY_DENIED'}}}
  event({},call);event(session,result);expect(notice).not.toHaveBeenCalled()
  event(session,call);event(session,{...result,data:{message:result.data.message}});expect(notice).not.toHaveBeenCalled()
  event(session,call);event(session,result);expect(notice).toHaveBeenCalledWith(expect.stringContaining('FS_POLICY_DENIED'));release()
})

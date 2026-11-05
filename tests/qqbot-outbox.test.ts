import { it, expect, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ChannelBridge, type BindingState } from '../src/plugin/bridge.js'
import { registerQQExternalTurns } from '../src/plugin/qqbot-external.js'
import type { ChannelMessage } from '../src/channels/types.js'

const message=(id:string,send=vi.fn(async()=>{}))=>({id,text:'',send,responding:async f=>f(),sendFile:vi.fn(),sendVoice:vi.fn()}) as ChannelMessage
function fixture(){
  const session=Session.create(SessionId('channels-outbox-test'))
  session.append('turn/start',{turn:1})
  session.append('user/message',createUserMessage({content:[{type:'text',text:'desktop task'}],source:{kind:'user'}}),{surfaceOp:'append'})
  session.append('assistant/message',{turn:1,message:{content:[{type:'text',text:'offline desktop answer'}]}},{surfaceOp:'append'})
  let state:BindingState={sessionId:session.id,receipts:[]},handler!:Function
  const store={read:()=>state,write:async(value:BindingState)=>{state=value}}
  const host={open:vi.fn(),inspect:vi.fn(async()=>undefined)},bridge=new ChannelBridge(host,store)
  const scheduledMessage=vi.fn(async(id:string)=>message(id))
  registerQQExternalTurns({on:(_event:string,fn:Function)=>{handler=fn;return()=>{}},sessions:{flush:async()=>true}} as any,{state:()=>state,bridge,adapter:{scheduledMessage} as any,policy:'c2c',signal:new AbortController().signal})
  const completion=()=>handler(session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
  return {bridge,store,host,scheduledMessage,completion,session}
}
it('journals offline desktop completion before looking up transport and recovers it once after restart',async()=>{
  const f=fixture();f.bridge.setConnected(false);f.completion()
  await vi.waitFor(()=>expect(f.store.read().receipts[0]).toMatchObject({delivery:'pending',result:{text:'offline desktop answer'}}))
  expect(f.scheduledMessage).not.toHaveBeenCalled();await f.bridge.close()
  const restarted=new ChannelBridge(f.host,f.store),send=vi.fn(async()=>{})
  await restarted.recover(async id=>message(id,send));await restarted.recover(async id=>message(id,send))
  expect(send).toHaveBeenCalledExactlyOnceWith('offline desktop answer');expect(f.host.inspect).not.toHaveBeenCalled()
  expect(f.store.read().receipts[0]?.delivery).toBe('sent');await restarted.close()
})
it('keeps a result pending if transport acquisition fails before any send',async()=>{
  const f=fixture();f.scheduledMessage.mockRejectedValue(new Error('QQ is not connected'));f.completion()
  await vi.waitFor(()=>expect(f.scheduledMessage).toHaveBeenCalledOnce());await f.bridge.drain()
  expect(f.store.read().receipts[0]?.delivery).toBe('pending')
  const send=vi.fn(async()=>{});await f.bridge.recover(async id=>message(id,send))
  expect(send).toHaveBeenCalledOnce();expect(f.store.read().receipts[0]?.delivery).toBe('sent');await f.bridge.close()
})
it('does not resend an ambiguous external send or quarantine a still-running send during recovery',async()=>{
  const f=fixture(),attempt=Promise.withResolvers<void>(),send=vi.fn(()=>attempt.promise)
  const sending=f.bridge.deliverExternal('external',f.session.id,{text:'answer',reason:'completed'},async id=>message(id,send))
  await vi.waitFor(()=>expect(send).toHaveBeenCalledOnce())
  const recovery=vi.fn(async id=>message(id,send));await f.bridge.recover(recovery)
  expect(recovery).not.toHaveBeenCalled();expect(f.store.read().receipts[0]?.delivery).toBe('sending')
  attempt.reject(new Error('unknown outcome'));await sending
  expect(f.store.read().receipts[0]?.delivery).toBe('uncertain')
  await f.bridge.recover(recovery);expect(send).toHaveBeenCalledOnce();await f.bridge.close()
})

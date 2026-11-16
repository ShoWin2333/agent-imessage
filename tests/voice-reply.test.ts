import { expect, it } from 'vitest'
import { voiceAwareResult } from '../src/plugin/voice/reply.js'
import { ChannelBridge, type BindingState, type Receipt } from '../src/plugin/bridge.js'

const transcript = 'Here is the example.\n\nPlease listen to this sound.'
const receipt = (delivery: 'sent' | 'sending' | 'uncertain' = 'sent'): Receipt => ({
  id:'recording',inputId:'input',sessionId:'session',delivery:'pending',
  voice:{text:transcript,callId:'audio-call'},
  media:[{callId:'audio-call',name:'reply.mp3',bytes:100,mode:'voice',delivery}],
})
const result = (text: string, reason = 'completed') => ({text,reason})
it.each(['',transcript,'Here is the example.\n\n Please listen to this sound. '])('suppresses only already-delivered content: %s',text=>{
  expect(voiceAwareResult(result(text),receipt())).toMatchObject({text:'',suppressed:true})
})
it.each([`${transcript}\n\nCould you clarify your question?`,`Could you clarify your question?\n\n${transcript}`])('preserves novel clarification alongside an identical transcript',text=>{
  expect(voiceAwareResult(result(text),receipt())).toEqual(result('Could you clarify your question?'))
})
it('does not treat partial matches, paraphrases or failure messages as delivered content',()=>{
  for(const text of ['Here is the example.','The demonstration is ready.','Delivery failed. Please try later.'])expect(voiceAwareResult(result(text),receipt())).toEqual(result(text))
  expect(voiceAwareResult(result(transcript,'interrupted'),receipt())).toEqual(result(transcript,'interrupted'))
  expect(voiceAwareResult(result(transcript),undefined)).toEqual(result(transcript))
})
it.each(['sending','uncertain'] as const)('preserves text and explicitly reports %s delivery',delivery=>{
  const value=voiceAwareResult(result(transcript),receipt(delivery))
  expect(value.suppressed).not.toBe(true);expect(value.text).toContain(transcript);expect(value.text).toContain('语音投递未确认')
  expect(voiceAwareResult(result(''),receipt(delivery)).text).toContain(transcript)
})
it.each(['sent','sending'] as const)('recovers the transcript/status without replaying audio after %s media',async delivery=>{
  let state: BindingState={sessionId:'session',receipts:[receipt(delivery)]}
  const send: string[]=[],uploads: string[]=[]
  const bridge=new ChannelBridge({inspect:async()=>result(transcript),open:async()=>{throw new Error('must not reopen')}} as never,{read:()=>state,write:async next=>{state=next}})
  try{
    await bridge.recover(async()=>({send:async text=>{send.push(text)},sendVoice:async()=>{uploads.push('voice')}} as never))
    expect(uploads).toHaveLength(0)
    expect(state.receipts[0]!.voice?.text).toBe(transcript)
    if(delivery==='sent'){expect(send).toHaveLength(0);expect(state.receipts[0]!.result?.suppressed).toBe(true)}
    else{expect(send[0]).toContain('语音投递未确认');expect(state.receipts[0]!.media![0]!.delivery).toBe('uncertain')}
  }finally{await bridge.close()}
})

it('distinguishes an upload that never started from an uncertain upload',()=>{
  const pending=receipt();pending.media=[]
  const value=voiceAwareResult(result(''),pending)
  expect(value.text).toContain('语音未开始投递');expect(value.text).not.toContain('可能已送达')
  expect(value.suppressed).not.toBe(true)
})

it('round-trips transcript and delivery status through the production storage schema and accepts old receipts',async()=>{
  const {channelDomain}=await import('../src/plugin/index.js')
  const schema=channelDomain.tables.bindings.valueSchema
  const parsed=schema.parse({sessionId:'session',receipts:[receipt()]})
  expect(parsed.receipts[0]).toMatchObject({voice:{text:transcript,callId:'audio-call'},media:[{delivery:'sent',mode:'voice'}]})
  const {voice:_,...oldReceipt}=receipt()
  expect(schema.parse({receipts:[oldReceipt]}).receipts[0]!.voice).toBeUndefined()
})

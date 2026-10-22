import { afterEach, expect, it, vi } from 'vitest'
import { ChannelInteractions, parseAnswer } from '../src/plugin/interactions.js'
import type { InteractionScope } from '../src/plugin/interaction-types.js'
import type { ChannelMessage } from '../src/channels/types.js'

function setup(timeout=120000) {
  let healthy=true,current=true
  const controller=new AbortController(),send=vi.fn(async(_text:string)=>{})
  const message={id:'synthetic',text:'task',send} as unknown as ChannelMessage
  const scope:InteractionScope={sessionId:'session-a',inputId:'input-a',turn:1,signal:controller.signal,current:()=>current}
  const broker=new ChannelInteractions(()=>healthy,timeout)
  const token=()=>send.mock.calls.at(-1)![0].match(/\/(?:approve|answer) ([aq]-[a-f0-9-]+)/)![1]!
  const ready=async()=>{await vi.waitFor(()=>expect(send).toHaveBeenCalled());await Promise.resolve();await Promise.resolve()}
  return {broker,scope,message,send,token,ready,controller,disconnect:()=>{healthy=false;broker.cancel()},invalidate:()=>{current=false}}
}
const approval=(f:ReturnType<typeof setup>)=>({...f.scope,toolName:'write_file',reason:'Write synthetic /tmp/demo once'})
const questions=[{id:'choice',question:'Pick one',options:[{label:'Yes',description:'Proceed'},{label:'No',description:'Stop'}]}]
afterEach(()=>vi.useRealTimers())
it('allows once, rejects token replay and never treats bare answers as grants',async()=>{
  const f=setup(),result=f.broker.approval(approval(f),f.message);await f.ready()
  const token=f.token();expect(()=>f.broker.reply('yes')).toThrow('用法')
  expect(f.broker.reply(`/approve ${token}`)).toContain('仅限本次');expect(await result).toBe('allowed-once')
  expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效')
})
it('isolates binding/session and request kind; invalid commands leave request pending',async()=>{
  const f=setup(),other=setup(),result=f.broker.approval(approval(f),f.message);await f.ready()
  expect(()=>other.broker.reply(`/approve ${f.token()}`)).toThrow('失效')
  expect(()=>f.broker.reply(`/answer ${f.token()} 1`)).toThrow('失效')
  expect(()=>f.broker.reply(`/approve ${f.token()} extra`)).toThrow('失效')
  f.broker.reply(`/deny ${f.token()}`);expect(await result).toBe('rejected')
})
it.each(['abort','disconnect','ownership','restart'] as const)('invalidates approval after %s',async change=>{
  const f=setup(),result=f.broker.approval(approval(f),f.message);await f.ready();const token=f.token()
  if(change==='abort')f.controller.abort()
  if(change==='disconnect')f.disconnect()
  if(change==='ownership')f.invalidate()
  if(change==='restart')f.broker.cancel()
  const target=change==='restart'?setup().broker:f.broker
  expect(()=>target.reply(`/approve ${token}`)).toThrow('失效')
  expect(await result).toBe('cancelled')
})
it('expires approvals and questions without retaining a reply capability',async()=>{
  vi.useFakeTimers();const f=setup(100),result=f.broker.approval(approval(f),f.message)
  await vi.advanceTimersByTimeAsync(1);const token=f.token()
  await vi.advanceTimersByTimeAsync(100)
  expect(await result).toBe('unavailable');expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效')
  const q=f.broker.question({...f.scope,questions},f.message);const rejected=expect(q).rejects.toMatchObject({code:'ASK_ABORTED'})
  await vi.advanceTimersByTimeAsync(101);await rejected
})
it('cannot approve before confirmed delivery, and a send failure fails closed',async()=>{
  const f=setup();let release!:()=>void;f.send.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve}))
  const result=f.broker.approval(approval(f),f.message);await vi.waitFor(()=>expect(f.send).toHaveBeenCalled())
  expect(()=>f.broker.reply(`/approve ${f.token()}`)).toThrow('尚未送达')
  release();await f.ready();f.broker.reply(`/deny ${f.token()}`);expect(await result).toBe('rejected')
  f.send.mockRejectedValue(new Error('synthetic delivery failure'))
  expect(await f.broker.approval(approval(f),f.message)).toBe('unavailable')
})
it('refuses missing reasons and overlong approvals/plan detail without truncating',async()=>{
  const f=setup()
  expect(await f.broker.approval({...approval(f),reason:undefined},f.message)).toBe('unavailable')
  expect(await f.broker.approval({...approval(f),reason:'x'.repeat(13000)},f.message)).toBe('unavailable')
  await expect(f.broker.question({...f.scope,questions:[{...questions[0]!,detail:'x'.repeat(13000),intent:{kind:'plan-review',approve:'Yes'}}]},f.message)).rejects.toMatchObject({code:'CHANNEL_UNAVAILABLE'})
  expect(f.send).not.toHaveBeenCalled()
})
it('returns typed answers, preserves plan detail and requires explicit plan choice',async()=>{
  const f=setup(),result=f.broker.question({...f.scope,questions:[{...questions[0]!,detail:'Full synthetic plan\nsecond line',intent:{kind:'plan-review',approve:'Yes'}}]},f.message)
  await f.ready();const token=f.token()
  expect(f.send.mock.calls[0]![0]).toContain('Full synthetic plan\nsecond line')
  expect(()=>f.broker.reply(`/approve ${token}`)).toThrow('失效')
  expect(()=>f.broker.reply(`/answer ${token} text:approve`)).toThrow('计划审批')
  expect(()=>f.broker.reply(`/answer ${token} 1,2`)).toThrow('单选题')
  f.broker.reply(`/answer ${token} 2`)
  expect(await result).toEqual({answers:[{id:'choice',selected:['No']}]})
})
it('aborts a question without a reply and rejects late replies',async()=>{
  const f=setup(),result=f.broker.question({...f.scope,questions},f.message),rejected=expect(result).rejects.toMatchObject({code:'ASK_ABORTED'})
  await f.ready();const token=f.token();f.controller.abort();await rejected
  expect(()=>f.broker.reply(`/answer ${token} 1`)).toThrow('失效')
})
it('validates complete native question IDs, option labels, duplicates, custom and multi-select',()=>{
  const qs=[{id:'a',question:'Select',multiSelect:true,options:[{label:'One'},{label:'Two'}]},{id:'b',question:'Free text'}]
  const valid={answers:[{id:'a',selected:['Two','One']},{id:'b',selected:[],custom:'literal comma, semicolon; and newline\ntext'}]}
  expect(parseAnswer(qs,JSON.stringify(valid))).toEqual(valid)
  for(const answers of [
    [{id:'a',selected:['One']}],
    [{id:'a',selected:['Unknown']},{id:'b',selected:[],custom:'ok'}],
    [{id:'a',selected:['One','One']},{id:'b',selected:[],custom:'ok'}],
    [{id:'a',selected:['One']},{id:'a',selected:['Two']}],
    [{id:'a',selected:['One']},{id:'b',selected:[],custom:'   '}],
  ])expect(()=>parseAnswer(qs,JSON.stringify({answers}))).toThrow()
  expect(()=>parseAnswer(qs,'1:One;2:free')).toThrow('JSON')
  expect(()=>parseAnswer(questions,'999')).toThrow('选项无效')
})
it('parallel requests have independent one-time tokens and invalid answer can be corrected',async()=>{
  const f=setup(),a=f.broker.approval(approval(f),f.message);await f.ready();const aToken=f.token()
  const q=f.broker.question({...f.scope,questions},f.message);await vi.waitFor(()=>expect(f.send).toHaveBeenCalledTimes(2));await Promise.resolve();await Promise.resolve()
  const qToken=f.token();expect(qToken).not.toBe(aToken)
  expect(()=>f.broker.reply(`/answer ${qToken} unknown`)).toThrow('选项')
  f.broker.reply(`/answer ${qToken} 1`);f.broker.reply(`/approve ${aToken}`)
  expect(await a).toBe('allowed-once');expect(await q).toEqual({answers:[{id:'choice',selected:['Yes']}]})
})
it('renders real newlines for action context, options and plan details',async()=>{
  const f=setup(),result=f.broker.approval(approval(f),f.message);await f.ready()
  expect(f.send.mock.calls[0]![0]).toContain('DSH 单次审批\n会话：')
  expect(f.send.mock.calls[0]![0]).not.toContain('\\n')
  f.broker.reply(`/deny ${f.token()}`);await result
  const question=f.broker.question({...f.scope,questions:[{...questions[0]!,detail:'Entire plan\nsecond line',intent:{kind:'plan-review',approve:'Yes'}}]},f.message)
  await vi.waitFor(()=>expect(f.send).toHaveBeenCalledTimes(2));await Promise.resolve();await Promise.resolve()
  expect(f.send.mock.calls[1]![0]).toContain('Entire plan\nsecond line')
  expect(f.send.mock.calls[1]![0]).not.toContain('\\n')
  f.broker.reply(`/answer ${f.token()} 2`);await question
})

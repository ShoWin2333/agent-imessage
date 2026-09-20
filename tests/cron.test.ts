import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cronMatches, parseCron, scheduleSchema } from '../src/gateway/cron.js'
import { GatewayRouter } from '../src/gateway/router.js'
import { Gateway } from '../src/gateway/app.js'
import { StateStore, type RouteState } from '../src/gateway/state.js'
import { appSchema } from '../src/app/config.js'
import { BaseBackend, type SessionOptions } from '../src/backends/types.js'
import type { ChannelMessage } from '../src/channels/types.js'
const route={id:'one',cwd:'/workspace',projectId:'p',projectSecretEnv:'SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
const task={id:'daily',name:'每日检查',enabled:true,cron:'0 9 * * *',timeZone:'Asia/Shanghai',channelId:'imessage',prompt:'检查项目并汇报'}
class Backend extends BaseBackend {
  initialize=vi.fn(async()=>{})
  openSession=vi.fn(async(o:SessionOptions)=>({id:o.id??'session',cwd:o.cwd}))
  startTurn=vi.fn(async(sessionId:string,_text:string)=>{this.onEvent({type:'started',sessionId,turnId:'turn'});return 'turn'})
  cancel=vi.fn(async()=>{})
  close=vi.fn(async()=>{this.onClose()})
}
const cleanups:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{vi.useRealTimers();for(const fn of cleanups.splice(0).reverse())await fn();vi.restoreAllMocks()})
const message=(id='cron:daily:1',text=task.prompt):ChannelMessage=>({id,text,send:vi.fn(async()=>{}),sendFile:async()=>{},sendVoice:async()=>{},responding:fn=>fn()})
it('matches numeric cron lists, steps, ranges, time zones and standard day OR rules',()=>{
  const monday=new Date('2026-09-21T01:00:00Z')
  expect(cronMatches('0 9 * * 1-5','Asia/Shanghai',monday)).toBe(true)
  expect(cronMatches('0 9 * * 1-5','UTC',monday)).toBe(false)
  expect(cronMatches('*/15 1-9/2 * 9 1,3','UTC',monday)).toBe(true)
  expect(cronMatches('0 9 1 * 1','Asia/Shanghai',monday)).toBe(true)
  expect(cronMatches('0 9 1 * *','Asia/Shanghai',monday)).toBe(false)
  expect(cronMatches('0 9 * * 7','Asia/Shanghai',new Date('2026-09-20T01:00:00Z'))).toBe(true)
  for(const invalid of ['* * * *','60 * * * *','*/0 * * * *','* 24 * * *','* * 0 * *','* * * 13 *','* * * * 8','5-2 * * * *','@daily','* * * * MON'])expect(()=>parseCron(invalid)).toThrow()
  expect(scheduleSchema.safeParse({...task,timeZone:'bad/zone'}).success).toBe(false)
  expect(appSchema.safeParse({routes:[{...route,schedules:[{...task,channelId:'another'}]}]}).success).toBe(false)
})
it('claims a slot before execution, ignores duplicate ticks, skips busy tasks and does not interpret prompts as commands',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:vi.fn(async()=>{})}
  const router=new GatewayRouter(backend,route,store);cleanups.push(()=>router.close());router.setConnected(true)
  const channel=message('cron:daily:1','/stop is text in a scheduled prompt')
  const get=vi.fn(async()=>{expect(store.save).toHaveBeenCalled();return channel})
  await router.schedule(task,1,get,false)
  await router.schedule(task,1,get,false)
  expect(backend.startTurn).toHaveBeenCalledExactlyOnceWith('session',channel.text)
  await router.schedule(task,2,get,true)
  expect(get).toHaveBeenCalledTimes(1)
  expect(router.snapshot().activity.at(-1)?.stage).toBe('schedule-skipped')
  expect(store.state.scheduleRuns?.daily).toBe(2)
})
it('never executes when a claim cannot be persisted or proactive delivery is unavailable',async()=>{
  const backend=new Backend(),store={state:{seen:[]} as RouteState,save:vi.fn(async()=>{})}
  const router=new GatewayRouter(backend,route,store);cleanups.push(()=>router.close());router.setConnected(true)
  store.save.mockRejectedValueOnce(new Error('disk failure'))
  const get=vi.fn(async()=>message())
  await expect(router.schedule(task,1,get,false)).rejects.toThrow()
  expect(get).not.toHaveBeenCalled()
  await router.schedule(task,2,async()=>{throw new Error('private-token')},false)
  expect(backend.startTurn).not.toHaveBeenCalled()
  expect(JSON.stringify(router.snapshot())).not.toContain('private-token')
})
it('restores private conversation history and durable slot claims after reopening state',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'cron-state-')));cleanups.push(()=>rm(dir,{recursive:true,force:true}))
  const store=await StateStore.open(dir,route),backend=new Backend(),router=new GatewayRouter(backend,route,store)
  router.setConnected(true);await router.schedule(task,1,async()=>message(),false)
  await router.close();await store.close()
  const reopened=await StateStore.open(dir,route);cleanups.push(()=>reopened.close())
  const nextBackend=new Backend(),next=new GatewayRouter(nextBackend,route,reopened);cleanups.push(()=>next.close());next.setConnected(true)
  await next.schedule(task,1,async()=>message(),false)
  expect(nextBackend.startTurn).not.toHaveBeenCalled()
  expect(next.snapshot().activity.some(e=>e.stage==='scheduled' && e.text?.includes(task.prompt))).toBe(true)
})
it('runs through the selected adapter/backend, delivers the result and skips disabled and missed slots',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'cron-gateway-')));cleanups.push(()=>rm(dir,{recursive:true,force:true}))
  const backend=new Backend(),outbound=message(),factory=vi.fn(async()=>{
    let end!:()=>void;const done=new Promise<void>(r=>{end=r})
    return {messages:(async function*(){await done})(),scheduledMessage:vi.fn(async(id:string,text:string)=>({...outbound,id,text})),stop:async()=>end()}
  })
  const config=appSchema.parse({stateDir:dir,routes:[{...route,cwd:dir,backend:'dsh',schedules:[task,{...task,id:'disabled',enabled:false}]}]})
  const gateway=new Gateway(config,{photon:{one:'secret'}},()=>backend,factory);cleanups.push(()=>gateway.stop());await gateway.start()
  await gateway.tickSchedules(new Date('2026-09-21T01:01:00Z'));expect(backend.startTurn).not.toHaveBeenCalled()
  await gateway.tickSchedules(new Date('2026-09-22T01:00:00Z'));expect(backend.startTurn).toHaveBeenCalledExactlyOnceWith('session',task.prompt)
  backend.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'reply',text:'定时汇报'})
  backend.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(()=>vi.mocked(outbound.send).mock.calls.length).toBe(1)
  expect(outbound.send).toHaveBeenCalledWith('定时汇报')
  await gateway.tickSchedules(new Date('2026-09-22T01:00:30Z'));expect(backend.startTurn).toHaveBeenCalledTimes(1)
})

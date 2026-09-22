import {afterEach, expect, it, vi} from 'vitest'
import {mkdtemp, realpath, rm, symlink, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BaseBackend, type SessionOptions} from '../src/backends/types.js'
import {GatewayRouter} from '../src/gateway/router.js'
import {StateStore, type RouteState} from '../src/gateway/state.js'
import {Gateway} from '../src/gateway/app.js'
import {appSchema} from '../src/app/config.js'
import {nextRuns} from '../src/gateway/cron.js'
import type {ChannelMessage} from '../src/channels/types.js'
const route = {id:'one',cwd:'/workspace',projectId:'p',projectSecretEnv:'SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
class Backend extends BaseBackend {
  initialize = vi.fn(async()=>{})
  openSession = vi.fn(async(o:SessionOptions)=>({id:o.id ?? 'session-'+this.openSession.mock.calls.length,cwd:o.cwd}))
  startTurn = vi.fn(async(sessionId:string,_text:string)=>{const turnId='turn-'+this.startTurn.mock.calls.length;this.onEvent({type:'started',sessionId,turnId});return turnId})
  cancel = vi.fn(async()=>{})
  close = vi.fn(async()=>{this.onClose()})
  complete(text='saved result') {
    const [sessionId] = this.startTurn.mock.calls.at(-1)!
    const turnId='turn-'+this.startTurn.mock.calls.length
    this.onEvent({type:'message',sessionId,turnId,id:'reply',text})
    this.onEvent({type:'completed',sessionId,turnId,status:'completed'})
  }
}
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn()})
const message=(id:string,text='task'):ChannelMessage=>({id,text,send:vi.fn(async()=>{}),sendFile:async()=>{},sendVoice:async()=>{},responding:fn=>fn()})
function routerFixture(acquire?:()=> (()=>void)|undefined) {
  const backend=new Backend(), store={state:{seen:[]} as RouteState, save:vi.fn(async()=>{})}
  const router=new GatewayRouter(backend,route,store,600_000,acquire)
  cleanup.push(()=>router.close());router.setConnected(true)
  return {backend,store,router}
}
it('persists completed results before delivery, survives transport failure, and resends without running the agent',async()=>{
  const {backend,store,router}=routerFixture(), channel=message('one')
  vi.mocked(channel.send).mockImplementation(async()=>{expect(store.state.tasks?.[0]?.execution).toBe('completed');expect(store.save).toHaveBeenCalled();throw new Error('private transport token')})
  await router.receive(channel);backend.complete()
  await expect.poll(()=>store.state.tasks?.[0]?.delivery).toBe('uncertain')
  expect(backend.close).not.toHaveBeenCalled()
  const task=store.state.tasks![0]!, retry=message('retry')
  await router.deliver(task,retry)
  expect(retry.send).toHaveBeenCalledExactlyOnceWith('saved result')
  expect(backend.startTurn).toHaveBeenCalledTimes(1)
  await expect(router.deliver(task,retry)).rejects.toThrow()
  expect(JSON.stringify(router.snapshot())).not.toContain('private transport token')
  await router.receive(message('two'));expect(backend.startTurn).toHaveBeenCalledTimes(2)
})
it('keeps task results beyond activity eviction and recovers interrupted/uncertain state without replay',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'task-state-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const store=await StateStore.open(dir,route)
  store.state.tasks=[{id:'old',messageId:'m',input:'original',startedAt:1,backend:'codex',execution:'completed',delivery:'sending',result:'result'},{id:'run',messageId:'r',input:'running',startedAt:2,backend:'codex',execution:'running',delivery:'pending'}]
  await store.save();await store.close()
  const recovered=await StateStore.open(dir,route);cleanup.push(()=>recovered.close())
  const backend=new Backend(),router=new GatewayRouter(backend,route,recovered);cleanup.push(()=>router.close());router.setConnected(true)
  for(let i=0;i<220;i++) await router.receive(message('help-'+i,'/help'))
  expect(router.snapshot().activity).toHaveLength(200)
  expect(router.snapshot().tasks).toMatchObject([{id:'old',delivery:'uncertain',result:'result'},{id:'run',execution:'interrupted'}])
  expect(backend.startTurn).not.toHaveBeenCalled()
})
it('only accepts a pending request once across desktop and phone, and scopes stop to a task ID',async()=>{
  const {backend,router}=routerFixture();await router.receive(message('one'))
  const pending=backend.onRequest({kind:'approval',sessionId:'session-1',turnId:'turn-1',payload:{details:{command:'test'}}})
  await expect.poll(()=>router.snapshot().requests.length).toBe(1)
  const request=router.snapshot().requests[0]!,task=router.snapshot().current!.taskId
  await router.control(task,'approve',request.id)
  await expect(pending).resolves.toEqual({decision:'accept'})
  await expect(router.control(task,'deny',request.id)).rejects.toThrow()
  await expect(router.control('old-task','stop')).rejects.toThrow()
  expect(backend.cancel).not.toHaveBeenCalled()
  await router.control(task,'stop');await expect(router.control(task,'stop')).rejects.toThrow()
  expect(backend.cancel).toHaveBeenCalledTimes(1)
})
it('keeps scheduled sessions separate and applies changed model options only to the next task',async()=>{
  const {backend,router,store}=routerFixture();await router.receive(message('interactive'));backend.complete()
  await expect.poll(()=>store.state.tasks?.[0]?.delivery).toBe('sent')
  router.updateModel({...route,model:'new-model',effort:'high'})
  const task={id:'daily',name:'Daily',enabled:true,cron:'0 9 * * *',timeZone:'UTC',channelId:'imessage',prompt:'check'}
  await router.schedule(task,1,async()=>message('scheduled'),false)
  expect(backend.openSession.mock.calls[1]![0]).toMatchObject({model:'new-model',effort:'high'})
  expect(backend.openSession.mock.calls[1]![0].id).toBeUndefined()
  expect(store.state.threadId).toBe('session-1')
  backend.complete();await expect.poll(()=>store.state.tasks?.[1]?.delivery).toBe('sent')
  await router.receive(message('interactive-again'))
  expect(backend.openSession.mock.calls[2]![0].id).toBe('session-1')
})
it('coordinates canonical workspaces across projects while allowing another directory, and safely saves metadata during execution',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'task-gateway-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  await mkdir(join(dir,'other'));await symlink(dir,join(dir,'alias'))
  const config=appSchema.parse({stateDir:join(dir,'state'),routes:[{...route,cwd:dir},{...route,id:'two',projectId:'p2',cwd:join(dir,'alias')},{...route,id:'three',projectId:'p3',cwd:join(dir,'other')}]})
  const backends:Backend[]=[], secrets={photon:{one:'s',two:'s',three:'s'}}
  const gateway=new Gateway(config,secrets,()=>{const b=new Backend();backends.push(b);return b},async()=>{
    let end!:()=>void;const done=new Promise<void>(r=>{end=r})
    return {messages:{async *[Symbol.asyncIterator](){yield message('first');await done}},stop:async()=>end()}
  });cleanup.push(()=>gateway.stop());await gateway.start()
  await expect.poll(()=>backends.map(b=>b.startTurn.mock.calls.length)).toEqual([1,0,1])
  const persisted=vi.fn(async()=>{})
  await gateway.replace({...config,routes:config.routes.map(r=>({...r,label:'Changed'}))},secrets,persisted)
  expect(persisted).toHaveBeenCalledTimes(1);expect(backends).toHaveLength(3)
  backends.forEach(b=>expect(b.close).not.toHaveBeenCalled())
  await expect(gateway.replace({...config,routes:config.routes.map(r=>({...r,approvalPolicy:'never'}))},secrets,persisted)).rejects.toThrow('先停止')
  expect(persisted).toHaveBeenCalledTimes(1)
  backends[0]!.complete();await expect.poll(()=>gateway.snapshot()[0]!.busy).toBe(false)
  await gateway.stop()
  expect(gateway.snapshot()[0]!.channels[0]!.tasks?.[0]?.result).toBe('saved result')
})
it('previews timezone-aware slots and skips nonexistent DST wall times',()=>{
  expect(nextRuns('0 9 * * 1-5','Asia/Shanghai',new Date('2026-09-20T00:00:00Z'),2)).toEqual([Date.parse('2026-09-21T01:00:00Z'),Date.parse('2026-09-22T01:00:00Z')])
  expect(nextRuns('30 2 * * *','America/New_York',new Date('2026-03-08T00:00:00Z'),1)).toEqual([Date.parse('2026-03-09T06:30:00Z')])
})
it('records unavailable and missed schedule slots without catch-up after a journal reload',async()=>{
  const dir=await realpath(await mkdtemp(join(tmpdir(),'schedule-journal-')));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const task={id:'daily',name:'Daily',enabled:true,cron:'0 9 * * *',timeZone:'UTC',channelId:'imessage',prompt:'check'}
  const config=appSchema.parse({stateDir:dir,routes:[{...route,cwd:dir,schedules:[task]}]})
  const gateway=new Gateway(config,{photon:{}});cleanup.push(()=>gateway.stop())
  await gateway.tickSchedules(new Date('2026-09-21T09:00:00Z'))
  expect(gateway.snapshot()[0]!.schedules[0]!.last?.detail).toContain('入口未启动')
  const restarted=new Gateway(config,{photon:{}});cleanup.push(()=>restarted.stop())
  await restarted.tickSchedules(new Date('2026-09-23T10:00:00Z'))
  expect(restarted.snapshot()[0]!.schedules[0]!.last?.detail).toContain('错过执行时间')
  expect(restarted.snapshot()[0]!.busy).toBe(false)
})
it('does not let a slow result delivery block the next task or desktop approval',async()=>{
  const {backend,router,store}=routerFixture(),channel=message('slow')
  let release!:()=>void
  vi.mocked(channel.send).mockImplementation(()=>new Promise<void>(resolve=>{release=resolve}))
  cleanup.push(async()=>{release?.()})
  await router.receive(channel);backend.complete()
  await expect.poll(()=>store.state.tasks?.[0]?.delivery).toBe('sending')
  await router.receive(message('next'))
  const request=backend.onRequest({kind:'approval',sessionId:'session-1',turnId:'turn-2',payload:{details:{command:'test'}}})
  await expect.poll(()=>router.snapshot().requests.length).toBe(1)
  await router.control(router.snapshot().current!.taskId,'approve',router.snapshot().requests[0]!.id)
  await expect(request).resolves.toEqual({decision:'accept'})
  release();await expect.poll(()=>store.state.tasks?.[0]?.delivery).toBe('sent')
})
it('delivers an oversized completed result before archiving it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'large-task-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const store=await StateStore.open(dir,route);cleanup.push(()=>store.close())
  const backend=new Backend(),router=new GatewayRouter(backend,route,store);cleanup.push(()=>router.close());router.setConnected(true)
  const channel=message('large'),result='x'.repeat(8*1024*1024+1)
  await router.receive(channel);backend.complete(result)
  await expect.poll(()=>store.archivedCount,{timeout:10000}).toBe(1)
  expect(vi.mocked(channel.send).mock.calls.map(call=>call[0]).join('')).toBe(result)
  await expect.poll(()=>store.archivedCount,{timeout:10000}).toBe(1)
  const page=await store.archivedTasks(),archived=page.tasks[0]!
  expect(archived.delivery).toBe('sent');expect(await store.task(archived.id,archived.archiveKey)).toMatchObject({result})
  expect(backend.startTurn).toHaveBeenCalledTimes(1)
},15000)

it('continues desktop turns in the exact session, starts new conversations explicitly and rejects busy or foreign sessions',async()=>{
  const {backend,router,store}=routerFixture()
  await router.submitDesktop({...message('desktop1','/new is literal text'),origin:'desktop'},undefined)
  expect(backend.startTurn).toHaveBeenLastCalledWith('session-1','/new is literal text')
  await expect(router.submitDesktop(message('busy'),'session-1')).rejects.toThrow('尚未结束')
  backend.complete();await expect.poll(()=>store.state.tasks?.[0]?.delivery).toBe('sent')
  await expect(router.submitDesktop(message('foreign'),'another-channel-session')).rejects.toThrow('不属于')
  await router.submitDesktop(message('desktop2'),'session-1')
  expect(backend.openSession).toHaveBeenCalledTimes(1)
  backend.complete();await expect.poll(()=>store.state.tasks?.[1]?.delivery).toBe('sent')
  await router.submitDesktop(message('desktop3'),undefined,true)
  expect(backend.startTurn).toHaveBeenLastCalledWith('session-2','task')
  expect(store.state.tasks?.map(t=>t.sessionId)).toEqual(['session-1','session-1','session-2'])
  backend.complete();await expect.poll(()=>store.state.tasks?.[2]?.delivery).toBe('sent')
  await router.submitDesktop(message('desktop4'),'session-1')
  expect(backend.openSession).toHaveBeenLastCalledWith(expect.objectContaining({id:'session-1'}))
})
it('preserves per-turn workflow beyond diagnostic eviction without bloating snapshots, and replaces streaming previews',async()=>{
  const {backend,router,store}=routerFixture();await router.receive(message('one'))
  for(let i=0;i<210;i++) backend.onEvent({type:'progress',sessionId:'session-1',turnId:'turn-1',phase:'tool-running',itemId:'tool-'+i,detail:'读取文件'})
  backend.onEvent({type:'commentary',sessionId:'session-1',turnId:'turn-1',id:'comment',text:'正在核对结果'})
  for(const text of ['hel','hello']) backend.onEvent({type:'preview',sessionId:'session-1',turnId:'turn-1',id:'answer',text})
  await expect.poll(()=>store.state.tasks?.[0]?.workflow?.filter(e=>e.stage==='preview').map(e=>e.text)).toEqual(['hello'])
  expect(router.snapshot().activity).toHaveLength(200)
  expect(store.state.tasks?.[0]?.workflow?.find(e=>e.itemId==='tool-0')).toBeDefined()
  expect(store.state.tasks?.[0]?.workflow?.find(e=>e.stage==='commentary')?.text).toBe('正在核对结果')
  expect(router.snapshot().tasks[0]).not.toHaveProperty('workflow')
  expect(router.snapshot().tasks[0]!.workflowRevision).toBeGreaterThan(210)
})
it('recovers persisted workflow and filters archive pagination by session without losing interleaved records',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'conversation-state-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}))
  const store=await StateStore.open(dir,route)
  store.state.tasks=Array.from({length:560},(_,i)=>({id:`task-${i}`,messageId:`m-${i}`,input:`message ${i}`,sessionId:i%2?'a':'b',startedAt:i+1,backend:'codex',execution:'completed',delivery:'sent',workflow:[{sequence:i+1,at:i+1,stage:'tool-completed',text:'读取文件'}]}))
  delete store.state.tasks[0]!.sessionId
  await store.save();await store.close()
  const reopened=await StateStore.open(dir,route);cleanup.push(()=>reopened.close())
  expect(reopened.state.tasks?.at(-1)?.workflow?.[0]?.text).toBe('读取文件')
  expect((await reopened.archivedTasks(undefined,'')).tasks.map(t=>t.id)).toEqual(['task-0'])
  const page=await reopened.archivedTasks(undefined,'a')
  expect(page.tasks).toHaveLength(25);expect(page.tasks.every(t=>t.sessionId==='a')).toBe(true)
  const next=await reopened.archivedTasks(page.nextCursor!,'a')
  expect(next.tasks).toHaveLength(5)
  expect(new Set([...page.tasks,...next.tasks].map(t=>t.id)).size).toBe(30)
  const archived=page.tasks[0]!
  expect((await reopened.task(archived.id,archived.archiveKey)).workflow?.[0]?.text).toBe('读取文件')
})
it('marks a desktop admission failure and releases the running state without replaying it',async()=>{
  const {backend,router,store}=routerFixture()
  backend.openSession.mockRejectedValueOnce(new Error('backend unavailable'))
  await expect(router.submitDesktop(message('desktop'),undefined)).rejects.toThrow()
  expect(router.snapshot().busy).toBe(false)
  expect(store.state.tasks?.[0]?.execution).toBe('interrupted')
  expect(store.state.tasks?.[0]?.reason).toContain('提交消息失败')
  expect(backend.startTurn).not.toHaveBeenCalled()
})
it('stops desktop session admission before starting a turn and deduplicates the same submitted message',async()=>{
  const {backend,router,store}=routerFixture()
  let release!:(value:{id:string;cwd:string})=>void
  backend.openSession.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
  const admission=router.submitDesktop(message('pending-desktop'),undefined)
  await expect.poll(()=>router.snapshot().busy).toBe(true)
  const id=router.snapshot().current!.taskId
  await router.control(id,'stop')
  release({id:'session-1',cwd:route.cwd});await admission
  expect(backend.startTurn).not.toHaveBeenCalled()
  expect(store.state.tasks?.[0]?.execution).toBe('interrupted')
  await router.submitDesktop(message('pending-desktop'),undefined)
  expect(store.state.tasks).toHaveLength(1)
  await router.submitDesktop(message('next-desktop'),undefined)
  expect(backend.startTurn).toHaveBeenCalledTimes(1)
})

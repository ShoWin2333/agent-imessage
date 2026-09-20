import {describe,it,expect} from 'vitest'
import {mkdtemp,rm,symlink,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {StateStore,type TaskRecord} from '../src/gateway/state.js'
import {TaskArchive,partitionTasks,taskSummary,HOT_TASK_BYTES} from '../src/gateway/task-history.js'
import {requestId,interactionPresentation} from '../src/gateway/interaction.js'
const task=(i:number):TaskRecord=>({id:String(i),messageId:String(i),input:'input'.repeat(100),result:'result'.repeat(200),startedAt:1700000000000+i,backend:'codex',execution:'completed',delivery:'uncertain'})
describe('task lifecycle',()=>{
 it('bounds thousands of full tasks, preserves archives, paginates and restores exact content',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'task-retention-'))
  const route={id:'route',cwd:'/tmp',projectId:'p',senderPhoneNumber:'s',assignedPhoneNumber:'a'} as any
  const store=await StateStore.open(dir,route)
  try {
   store.state.tasks=Array.from({length:1100},(_,i)=>task(i))
   const original=store.state.tasks[599]!
   await store.save()
   expect(store.state.tasks).toHaveLength(500);expect(store.archivedCount).toBe(600)
   const page=await store.archivedTasks();expect(page.tasks).toHaveLength(25)
   expect(page.tasks[0]!.id).toBe('599');expect(page.tasks[0]!.resultTruncated).toBe(true)
   expect(await store.task('599',page.tasks[0]!.archiveKey)).toEqual(original)
   const next=await store.archivedTasks(page.nextCursor!);expect(next.tasks[0]!.id).toBe('574')
   const restored=await store.restoreTask('599',page.tasks[0]!.archiveKey),unpin=store.pinTask(restored.id)
   restored.delivery='sending';await store.save();expect(store.state.tasks).toContain(restored)
   restored.delivery='sent';await store.save();unpin();await store.save()
   expect((await store.task('599',page.tasks[0]!.archiveKey)).delivery).toBe('sent')
   await expect(store.task('wrong',page.tasks[0]!.archiveKey)).rejects.toThrow('identity')
  } finally {await store.close();await rm(dir,{recursive:true,force:true})}
 })
 it('keeps running and sending objects regardless of byte budget; summaries remain small',()=>{
  const huge={...task(1),result:'x'.repeat(HOT_TASK_BYTES+1)}
  expect(partitionTasks([huge]).hot).toHaveLength(0)
  expect(partitionTasks([huge],new Set(['1'])).hot).toHaveLength(1)
  expect(partitionTasks([{...huge,execution:'running'}]).hot).toHaveLength(1)
  expect(partitionTasks([{...huge,delivery:'sending'}]).hot).toHaveLength(1)
  expect(JSON.stringify(taskSummary(huge)).length).toBeLessThan(2000)
 })
 it('archive failure preserves hot records and rejects symlinks/traversal',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'task-failure-')),store=await StateStore.open(dir,{id:'r',cwd:'/tmp'} as any)
  try {
   await mkdir(join(dir,'target'),{mode:0o700});await symlink(join(dir,'target'),join(dir,'archives'))
   store.state.tasks=Array.from({length:501},(_,i)=>task(i))
   await expect(store.save()).rejects.toThrow();expect(store.state.tasks).toHaveLength(501)
   await expect(new TaskArchive(join(dir,'archives','route')).read('../../secret')).rejects.toThrow('Invalid archive key')
  } finally {await store.close();await rm(dir,{recursive:true,force:true})}
 })
 it('short IDs retry collisions, and readable requests preserve command and choices',()=>{
  const values=['used','0123456789'];expect(requestId(new Set(['used']),()=>values.shift()!)).toBe('0123456789')
  expect(requestId(new Set())).toMatch(/^[a-f0-9]{10}$/)
  const p=interactionPresentation('Codex','item/commandExecution/requestApproval',{command:'npm test',cwd:'/tmp',reason:'验证',additionalPermissions:{network:true}},[])
  expect(p).toMatchObject({command:'npm test',cwd:'/tmp',reason:'验证',extraPermissions:true})
  expect(interactionPresentation('Codex','item/tool/requestUserInput',{questions:[{id:'q',question:'选择环境',options:[{label:'本机',description:'在 Mac 上运行'}]}]},undefined).questions[0]).toMatchObject({prompt:'选择环境',options:[{label:'本机'}]})
 })
})

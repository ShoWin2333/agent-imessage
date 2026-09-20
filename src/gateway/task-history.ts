import {createHash, randomUUID} from 'node:crypto'
import {mkdir, lstat, readdir, readFile, writeFile, rename, rm} from 'node:fs/promises'
import {join, dirname} from 'node:path'
import type {TaskRecord} from './state.js'

export const HOT_TASK_LIMIT = 500
export const HOT_TASK_BYTES = 8 * 1024 * 1024
export function taskSummary(task: TaskRecord) {
  return {...task,input:task.input.slice(0,400),...(task.result !== undefined ? {result:task.result.slice(0,800)} : {}),inputTruncated:task.input.length>400,resultTruncated:(task.result?.length ?? 0)>800}
}
export function partitionTasks(tasks: TaskRecord[], pinned = new Set<string>()) {
  const keep = new Set<string>()
  let bytes = 0
  // In-flight work must retain its live object and durable state even above the budget.
  for (const task of tasks) if (pinned.has(task.id) || task.execution === 'running' || task.delivery === 'sending') {
    keep.add(task.id); bytes += Buffer.byteLength(JSON.stringify(task))
  }
  for (const task of [...tasks].sort((a,b)=>b.startedAt-a.startedAt)) {
    if (keep.has(task.id)) continue
    const size = Buffer.byteLength(JSON.stringify(task))
    if (keep.size < HOT_TASK_LIMIT && bytes + size <= HOT_TASK_BYTES) { keep.add(task.id); bytes += size }
  }
  return {hot:tasks.filter(t=>keep.has(t.id)),archive:tasks.filter(t=>!keep.has(t.id))}
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path,{recursive:true,mode:0o700})
  const info=await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Archive directory must be private')
}
export async function atomicStateFile(file: string, content: string): Promise<void> {
  const temp=`${file}.${randomUUID()}.tmp`
  try { await writeFile(temp,content,{mode:0o600,flag:'wx'}); await rename(temp,file) }
  finally { await rm(temp,{force:true}) }
}
/** Monthly folders, one atomic record per task: retrying archive-before-prune is idempotent. */
export class TaskArchive {
  count = 0
  constructor(private readonly root: string) {}
  private key(task: TaskRecord): string {
    const month = new Date(task.startedAt).toISOString().slice(0,7)
    const key=`${month}/${String(task.startedAt).padStart(16,'0')}-${createHash('sha256').update(task.id).digest('hex')}.json`
    if (!this.valid(key)) throw new Error('Invalid task timestamp')
    return key
  }
  private valid(key: string): boolean { return /^\d{4}-\d{2}\/\d{16}-[a-f0-9]{64}\.json$/.test(key) }
  private async keys(): Promise<string[]> {
    let months: string[]
    try {
      // Check every level before traversing; archives never follow directory symlinks.
      for (const dir of [dirname(this.root),this.root]) {
        const info=await lstat(dir)
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Invalid archive directory')
      }
      months=await readdir(this.root)
    } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return []; throw error }
    const keys:string[]=[]
    for (const month of months.filter(m=>/^\d{4}-\d{2}$/.test(m))) {
      const info=await lstat(join(this.root,month))
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Invalid archive month')
      keys.push(...(await readdir(join(this.root,month))).map(name=>`${month}/${name}`).filter(key=>this.valid(key)))
    }
    return keys.sort().reverse()
  }
  async load(): Promise<void> { this.count=(await this.keys()).length }
  async write(task: TaskRecord): Promise<void> {
    const key=this.key(task), file=join(this.root,key)
    await privateDirectory(dirname(this.root)); await privateDirectory(this.root); await privateDirectory(dirname(file))
    let exists=false
    try { const info=await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid archive record'); exists=true }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
    await atomicStateFile(file,JSON.stringify(task))
    if (!exists) this.count++
  }
  async read(key: string): Promise<TaskRecord> {
    if (!this.valid(key)) throw new Error('Invalid archive key')
    for (const dir of [dirname(this.root),this.root,dirname(join(this.root,key))]) {
      const info=await lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Invalid archive directory')
    }
    const file=join(this.root,key), info=await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Invalid archive record')
    const task=JSON.parse(await readFile(file,'utf8')) as TaskRecord
    if (typeof task.id!=='string' || typeof task.input!=='string' || (task.result!==undefined && typeof task.result!=='string') || this.key(task)!==key) throw new Error('Invalid archived task')
    return task
  }
  async page(cursor?: string, exclude: string[] = []) {
    if (cursor && !this.valid(cursor)) throw new Error('Invalid archive cursor')
    const keys=await this.keys(), skip=new Set(exclude)
    const remaining=cursor ? keys.filter(k=>k<cursor) : keys
    const tasks=[]
    let scanned=0
    while (scanned<remaining.length && tasks.length<25) {
      const archiveKey=remaining[scanned++]!, task=await this.read(archiveKey)
      if (!skip.has(task.id)) tasks.push({...taskSummary(task),archiveKey})
    }
    return {tasks,nextCursor:scanned<remaining.length ? remaining[scanned-1] : null,total:this.count}
  }
}

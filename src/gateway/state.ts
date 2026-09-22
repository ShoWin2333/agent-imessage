import { TaskArchive, atomicStateFile, partitionTasks } from './task-history.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import type { RouteConfig } from './config.js'

export interface WorkflowEntry {
  sequence: number; at: number; stage: string; text?: string; itemId?: string
}
export interface TaskRecord {
  workflow?: WorkflowEntry[]; workflowTruncated?: boolean; origin?: 'desktop'

  id: string; messageId: string; input: string; startedAt: number; finishedAt?: number
  sessionId?: string; model?: string; backend: string; result?: string
  reason?: string; cwd?: string; effort?: string; speed?: string; approvalPolicy?: string
  execution: 'running' | 'completed' | 'interrupted' | 'failed'
  delivery: 'pending' | 'sending' | 'sent' | 'uncertain'
}
export interface RouteState {
  tasks?: TaskRecord[]
  activity?: Array<{sequence:number;at:number;messageId?:string;stage:string;text?:string;itemId?:string}>
  scheduleRuns?: Record<string, number>
  weixinContext?: string
  channelCursor?: string
  threadId?: string
  seen: string[]
  sessions?: string[]
}
/** Route identity includes the authorized sender and workspace, so config edits cannot inherit another route's thread. */
export class StateStore {
  readonly state: RouteState = { seen: [] }
  private tail: Promise<void> = Promise.resolve()
  private readonly pinned = new Map<string,number>()
  pinTask(id: string): () => void {
    this.pinned.set(id,(this.pinned.get(id) ?? 0)+1)
    return () => {
      const count=(this.pinned.get(id) ?? 1)-1
      if (count) this.pinned.set(id,count); else this.pinned.delete(id)
      void this.save().catch(() => {})
    }
  }
  private readonly archive: TaskArchive
  get archivedCount(): number { return this.archive.count }
  private constructor(private readonly file: string, private readonly lock: string) { this.archive=new TaskArchive(join(dirname(file),'archives',basename(file,'.json'))) }
  async archivedTasks(cursor?: string, sessionId?: string) { await this.tail; return this.archive.page(cursor,(this.state.tasks ?? []).map(t=>t.id),sessionId) }
  async task(id: string, archiveKey?: string): Promise<TaskRecord> {
    await this.tail
    const hot=this.state.tasks?.find(t=>t.id===id)
    if (hot) return hot
    if (!archiveKey) throw new Error('Task not found')
    const task=await this.archive.read(archiveKey)
    if (task.id!==id) throw new Error('Task identity mismatch')
    return task
  }
  async restoreTask(id: string, archiveKey?: string): Promise<TaskRecord> {
    const task=await this.task(id,archiveKey)
    this.state.tasks ??= []
    const existing=this.state.tasks.find(t=>t.id===id)
    if (existing) return existing
    this.state.tasks.push(task)
    return task
  }

  static async open(dir: string, route: RouteConfig, channelIdentity?: string): Promise<StateStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('State directory must be a private directory (chmod 700)')
    const key = createHash('sha256').update(JSON.stringify([route.id, route.cwd, route.projectId, route.senderPhoneNumber, route.assignedPhoneNumber, ...(channelIdentity ? [channelIdentity] : []), ...(route.backend === 'cursor' ? ['cursor-sdk', route.cursorMode ?? 'agent'] : route.backend === 'dsh' ? ['dsh'] : [])])).digest('hex')
    // Lock the route id as well as its state, preventing duplicate listeners after config edits.
    const lock = join(dir, `${route.id}.lock`)
    try { await mkdir(lock, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Only reclaim a dead process's lock; EPERM and incomplete locks fail closed.
      const pid = Number(await readFile(join(lock, 'pid'), 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid lock owner')
      try { process.kill(pid, 0); throw new Error('Route already running') }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe }
      await mkdir(join(lock, 'reap'), { mode: 0o700 })
      await rm(lock, { recursive: true })
      await mkdir(lock, { mode: 0o700 })
    }
    const store = new StateStore(join(dir, `${key}.json`), lock)
    try {
      await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
      try {
        const raw: unknown = JSON.parse(await readFile(store.file, 'utf8'))
        if (!raw || typeof raw !== 'object') throw new Error('Invalid state')
        const value = raw as Record<string, unknown>
        if (!Array.isArray(value.seen) || !value.seen.every(x => typeof x === 'string') || (value.threadId !== undefined && typeof value.threadId !== 'string')) throw new Error('Invalid state')
        store.state.seen = value.seen.slice(-1024)
        if (value.tasks !== undefined) {
          if (!Array.isArray(value.tasks) || !value.tasks.every(t => t && ['id','messageId','input','backend'].every(k => typeof t[k] === 'string') && Number.isFinite(t.startedAt) && ['running','completed','interrupted','failed'].includes(t.execution) && ['pending','sending','sent','uncertain'].includes(t.delivery) && ['result','sessionId','model','cwd','effort','speed','approvalPolicy','reason'].every(k => t[k] === undefined || typeof t[k] === 'string'))) throw new Error('Invalid task records')
          for (const task of value.tasks as TaskRecord[]) {
            if (task.workflow !== undefined && (!Array.isArray(task.workflow) || !task.workflow.every(e => e && Number.isSafeInteger(e.sequence) && Number.isFinite(e.at) && typeof e.stage === 'string' && (e.text === undefined || typeof e.text === 'string') && (e.itemId === undefined || typeof e.itemId === 'string')))) throw new Error('Invalid workflow')
          }
          store.state.tasks = (value.tasks as TaskRecord[]).map(t => ({...t, ...(t.execution === 'running' ? {execution:'interrupted' as const,reason:'服务重启前任务未确认结束，请检查本机结果；不会自动重跑。'} : {}), delivery:t.delivery === 'sending' ? 'uncertain' : t.delivery}))
        }
        if (value.sessions !== undefined) {
          if (!Array.isArray(value.sessions) || !value.sessions.every(id => typeof id === 'string')) throw new Error('Invalid sessions')
          store.state.sessions = value.sessions.slice(-100)
        }
        if (Array.isArray(value.activity)) store.state.activity = value.activity.filter((entry): entry is NonNullable<RouteState['activity']>[number] => {
          if (!entry || typeof entry !== 'object') return false
          const row = entry as Record<string,unknown>
          return Number.isSafeInteger(row.sequence) && typeof row.at === 'number' && typeof row.stage === 'string' && ['messageId','text','itemId'].every(key => row[key] === undefined || typeof row[key] === 'string')
        }).slice(-200).map(entry => ({...entry, ...(entry.text ? {text:entry.text.slice(0,8050)} : {})}))
        if (value.scheduleRuns && typeof value.scheduleRuns === 'object' && !Array.isArray(value.scheduleRuns)) store.state.scheduleRuns = Object.fromEntries(Object.entries(value.scheduleRuns).filter(([_, minute]) => Number.isSafeInteger(minute))) as Record<string,number>
        if (typeof value.weixinContext === 'string') store.state.weixinContext = value.weixinContext
        if (typeof value.channelCursor === 'string') store.state.channelCursor = value.channelCursor
        if (typeof value.threadId === 'string') store.state.threadId = value.threadId
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await store.archive.load()
      // Migrate old unbounded state before exposing it to polling clients.
      if (partitionTasks(store.state.tasks ?? []).archive.length) await store.save()
      return store
    } catch (error) { await store.close(); throw error }
  }

  save(): Promise<void> {
    // Capture before queuing: later mutations must never change this transaction.
    const snapshot = JSON.parse(JSON.stringify(this.state)) as RouteState
    const {hot,archive}=partitionTasks(snapshot.tasks ?? [],new Set(this.pinned.keys()))
    if (snapshot.tasks) snapshot.tasks=hot
    const operation = this.tail.then(async () => {
      // Archive first. A crash/failure can leave duplicates, never lost task contents.
      for (let offset=0;offset<archive.length;offset+=16) {
        const results=await Promise.allSettled(archive.slice(offset,offset+16).map(task=>this.archive.write(task)))
        const failure=results.find(r=>r.status==='rejected')
        if (failure?.status==='rejected') throw failure.reason
      }
      await atomicStateFile(this.file,JSON.stringify(snapshot))
      if (archive.length) {
        const removed=new Map(archive.map(t=>[t.id,JSON.stringify(t)]))
        this.state.tasks=this.state.tasks?.filter(t=>removed.get(t.id)!==JSON.stringify(t)) ?? []
      }
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  async close(): Promise<void> { await this.tail; await rm(this.lock, { recursive: true, force: true }) }
}

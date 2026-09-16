import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RouteConfig } from './config.js'

export interface RouteState {
  threadId?: string
  seen: string[]
}
/** Route identity includes the authorized sender and workspace, so config edits cannot inherit another route's thread. */
export class StateStore {
  readonly state: RouteState = { seen: [] }
  private tail: Promise<void> = Promise.resolve()
  private constructor(private readonly file: string, private readonly lock: string) {}

  static async open(dir: string, route: RouteConfig): Promise<StateStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('State directory must be a private directory (chmod 700)')
    const key = createHash('sha256').update(JSON.stringify([route.id, route.cwd, route.projectId, route.senderPhoneNumber, route.assignedPhoneNumber])).digest('hex')
    // Lock the route id as well as its state, preventing duplicate listeners after config edits.
    const lock = join(dir, `${route.id}.lock`)
    await mkdir(lock, { mode: 0o700 })
    const store = new StateStore(join(dir, `${key}.json`), lock)
    try {
      await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
      try {
        const raw: unknown = JSON.parse(await readFile(store.file, 'utf8'))
        if (!raw || typeof raw !== 'object') throw new Error('Invalid state')
        const value = raw as Record<string, unknown>
        if (!Array.isArray(value.seen) || !value.seen.every(x => typeof x === 'string') || (value.threadId !== undefined && typeof value.threadId !== 'string')) throw new Error('Invalid state')
        store.state.seen = value.seen.slice(-1024)
        if (typeof value.threadId === 'string') store.state.threadId = value.threadId
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return store
    } catch (error) { await store.close(); throw error }
  }

  save(): Promise<void> {
    const snapshot = JSON.stringify(this.state)
    const operation = this.tail.then(async () => {
      const temp = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { mode: 0o600, flag: 'wx' })
        await rename(temp, this.file)
      } finally { await rm(temp, { force: true }) }
    })
    this.tail = operation.catch(() => {})
    return operation
  }
  async close(): Promise<void> { await this.tail; await rm(this.lock, { recursive: true, force: true }) }
}

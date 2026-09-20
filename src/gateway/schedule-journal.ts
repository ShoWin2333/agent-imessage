import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {atomicJson} from '../app/config.js'

export interface ScheduleOutcome { at: number; status: string; detail: string }
/** Scheduler diagnostics survive unavailable channels, sleep and process restarts. */
export class ScheduleJournal {
  lastMinute: number | undefined
  readonly outcomes: Record<string,ScheduleOutcome> = {}
  private loaded = false
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const value = JSON.parse(await readFile(join(this.directory,'schedules.json'),'utf8'))
      if (Number.isSafeInteger(value.lastMinute)) this.lastMinute = value.lastMinute
      if (value.outcomes && typeof value.outcomes === 'object') for (const [key,row] of Object.entries(value.outcomes)) {
        const r=row as ScheduleOutcome
        if (r && typeof r.at === 'number' && typeof r.status === 'string' && typeof r.detail === 'string') this.outcomes[key]=r
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.loaded = true
  }
  async save(): Promise<void> { await atomicJson(join(this.directory,'schedules.json'),{lastMinute:this.lastMinute,outcomes:this.outcomes}) }
}

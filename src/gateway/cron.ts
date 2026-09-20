import { z } from 'zod'

/** Five numeric fields: minute hour day-of-month month day-of-week (0/7 = Sun). */
export function parseCron(expression: string): Array<{values:Set<number>;wildcard:boolean}> {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5 || expression.length > 160) throw new Error('Use five cron fields')
  return fields.map((field,index) => {
    const [min,max] = [[0,59],[0,23],[1,31],[1,12],[0,7]][index]!
    const values = new Set<number>()
    for (const part of field.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
      if (!match) throw new Error('Invalid cron field')
      const step = Number(match[2] ?? 1), range = match[1]!
      if (!Number.isInteger(step) || step < 1 || step > max! - min! + 1) throw new Error('Invalid cron step')
      const [start,end] = range === '*' ? [min!,max!] : range.includes('-') ? range.split('-').map(Number) : [Number(range), match[2] ? max! : Number(range)]
      if (start! < min! || end! > max! || start! > end!) throw new Error('Invalid cron range')
      for (let value=start!;value<=end!;value+=step) values.add(index === 4 && value === 7 ? 0 : value)
    }
    return {values,wildcard:field.startsWith('*')}
  })
}
export function validTimeZone(zone: string): boolean { try { new Intl.DateTimeFormat('en',{timeZone:zone}).format(); return true } catch { return false } }
export const scheduleSchema = z.object({
  id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), name:z.string().trim().min(1).max(100),
  enabled:z.boolean(), cron:z.string().refine(value => {try {parseCron(value);return true} catch {return false}},'Use five numeric cron fields'),
  timeZone:z.string().max(100).refine(validTimeZone,'Invalid time zone'),
  channelId:z.string().min(1).max(64), prompt:z.string().trim().min(1).max(8000),
}).strict()
export type ScheduledTask = z.infer<typeof scheduleSchema>
export function cronMatches(expression: string, timeZone: string, now: Date): boolean {
  const fields = parseCron(expression)
  const parts = new Intl.DateTimeFormat('en-US',{timeZone,minute:'2-digit',hour:'2-digit',hourCycle:'h23',day:'2-digit',month:'2-digit',weekday:'short'}).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)!.value
  const values = [Number(part('minute')),Number(part('hour')),Number(part('day')),Number(part('month')),['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(part('weekday'))]
  const matches = fields.map((field,index) => field.values.has(values[index]!))
  const dayMatches = fields[2]!.wildcard || fields[4]!.wildcard ? matches[2] && matches[4] : matches[2] || matches[4]
  return Boolean(matches[0] && matches[1] && matches[3] && dayMatches)
}

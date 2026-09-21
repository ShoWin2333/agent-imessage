import { describe, expect, it } from 'vitest'
import { rememberInbound, type InboundDedupeTable } from '../src/dedupe.js'

class MemoryTable implements InboundDedupeTable {
  readonly values: Map<string, { receivedAt: number }>

  constructor(values = new Map<string, { receivedAt: number }>()) {
    this.values = values
  }

  get size(): number { return this.values.size }
  get(id: string) { return this.values.get(id) }
  async put(id: string, value: { receivedAt: number }) { this.values.set(id, value) }
  async delete(id: string) { this.values.delete(id) }
  keys() { return this.values.keys() }
  entries() { return this.values.entries() }
}

describe('durable inbound replay window', () => {
  it('deduplicates across adapter restarts backed by the same durable state', async () => {
    const durable = new Map<string, { receivedAt: number }>()
    const beforeRestart = new MemoryTable(durable)
    expect(await rememberInbound(beforeRestart, 'provider-message-1', 1_024, 1)).toBe(true)
    const afterRestart = new MemoryTable(durable)
    expect(await rememberInbound(afterRestart, 'provider-message-1', 1_024, 2)).toBe(false)
  })

  it('retains exactly the newest bounded window with stable tie-breaking', async () => {
    const table = new MemoryTable()
    await rememberInbound(table, 'b', 3, 1)
    await rememberInbound(table, 'a', 3, 1)
    await rememberInbound(table, 'c', 3, 2)
    await rememberInbound(table, 'd', 3, 3)
    expect([...table.keys()]).toEqual(['b', 'c', 'd'])
  })
})

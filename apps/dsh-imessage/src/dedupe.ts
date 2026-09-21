/** Minimal durable table face needed by the inbound replay window. */
export interface InboundDedupeTable {
  readonly size: number
  get(id: string): { receivedAt: number } | undefined
  put(id: string, value: { receivedAt: number }): Promise<void>
  delete(id: string): Promise<unknown>
  keys(): Iterable<string>
  entries(): Iterable<[string, { receivedAt: number }]>
}

/** Atomically remember one provider message id and trim the oldest entries. */
export async function rememberInbound(
  table: InboundDedupeTable,
  id: string,
  limit: number,
  receivedAt = Date.now(),
): Promise<boolean> {
  if (table.get(id) !== undefined) return false
  await table.put(id, { receivedAt })
  if (table.size > limit) {
    const excess = table.size - limit
    const oldest = [...table.entries()]
      .sort((left, right) => left[1].receivedAt - right[1].receivedAt || left[0].localeCompare(right[0]))
      .slice(0, excess)
    for (const [oldId] of oldest) await table.delete(oldId)
  }
  return true
}

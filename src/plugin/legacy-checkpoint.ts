import { z } from 'zod'
/** Accept only explicitly extracted metadata, never an old route state/history file. */
const checkpointSchema = z.object({
  seen: z.array(z.string().min(1)).max(1024),
  // iLink buffers are opaque, including empty strings and numeric-looking values.
  // Match the whitelist reader's selected JSON value limit, including escaping.
  // Larger buffers fail closed; never decode, trim or log a buffer.
  channelCursor: z.string().refine(v => Buffer.byteLength(JSON.stringify(v), 'utf8') <= 1024 * 1024).optional(),
}).strict()
export function legacyCheckpoint(value: unknown, kind: string): { seen: string[]; legacySeen: string[]; channelCursor?: string } {
  const result = checkpointSchema.safeParse(value)
  // A cursor can contain sensitive session metadata: do not expose parse details.
  if (!result.success || !['imessage','telegram','weixin','discord'].includes(kind)) throw new Error('Invalid legacy channel checkpoint')
  const parsed = result.data, cursor = parsed.channelCursor
  if (cursor !== undefined && (kind === 'telegram' ? !/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)) : kind !== 'weixin')) throw new Error('Invalid legacy channel checkpoint')
  return { seen: [...new Set(parsed.seen)], legacySeen: [...new Set(parsed.seen)], ...(parsed.channelCursor === undefined ? {} : { channelCursor: parsed.channelCursor }) }
}
export function wasLegacyMessage(seen: ReadonlySet<string>, id: string): boolean { return seen.has(id) }

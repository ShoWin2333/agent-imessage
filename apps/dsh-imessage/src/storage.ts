import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Durable local state for per-route session selection and inbound deduplication. */
export const pluginDomainSpec = defineDomain({
  name: 'dsh_imessage',
  version: 1,
  global: {
    schema: z.object({
      /** @deprecated Prefer activeSessions; retained for migration from single-route installs. */
      activeSessionId: z.string().min(1).optional(),
      /** Selected root session id keyed by local route id. */
      activeSessions: z.record(z.string(), z.string().min(1)).optional(),
    }),
    initial: {} as {
      activeSessionId?: string
      activeSessions?: Record<string, string>
    },
  },
  tables: {
    inbound: domainTable<string, { receivedAt: number }>(z.object({
      receivedAt: z.number().int().nonnegative(),
    })),
  },
})

/** Read the active session for one route, falling back to legacy single-route storage. */
export function readActiveSession(
  global: { activeSessionId?: string | undefined; activeSessions?: Record<string, string> | undefined },
  routeId: string,
): string | undefined {
  const mapped = global.activeSessions?.[routeId]
  if (mapped !== undefined) return mapped
  if (routeId === 'default') return global.activeSessionId
  return undefined
}

/** Write the active session for one route without dropping other route selections. */
export function writeActiveSessions(
  global: { activeSessionId?: string | undefined; activeSessions?: Record<string, string> | undefined },
  routeId: string,
  sessionId: string | undefined,
): { activeSessions?: Record<string, string> } {
  const activeSessions = { ...(global.activeSessions ?? {}) }
  if (global.activeSessionId !== undefined && activeSessions.default === undefined) {
    activeSessions.default = global.activeSessionId
  }
  if (sessionId === undefined) delete activeSessions[routeId]
  else activeSessions[routeId] = sessionId

  if (Object.keys(activeSessions).length === 0) return {}
  return { activeSessions }
}

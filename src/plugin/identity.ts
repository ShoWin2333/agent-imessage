import { createHash } from 'node:crypto'
import type { Binding } from './config.js'
import type { BindingState } from './bridge.js'

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * Durable scope for one channel binding: channel identity, canonical workspace,
 * permissions and model selection, exactly as documented in the migration guide.
 *
 * The credential reference and the activation flag are deliberately excluded:
 * rotating a credential or enabling/disabling a binding must keep its session,
 * its dedupe window and its own receipt journal.
 */
export function bindingKey(binding: Binding): string {
  const { enabled: _enabled, credentialRef: _credentialRef, ...identity } = binding
  return digest(identity)
}

/**
 * Previous scope key, which also folded the credential reference into the hash.
 * Only used to carry an existing row forward; never written by new code.
 */
export function legacyBindingKey(binding: Binding): string {
  const { enabled: _enabled, ...identity } = binding
  return digest(identity)
}

/** An explicit grant for the exact sessions found in this binding's old journal. */
export interface LegacySessionIdentity { key: string; sessionIds: string[] }
const scopedSession = (id: string, key: string): boolean =>
  id.startsWith(`channels-${key}-`) && id.length > `channels-${key}-`.length

export function ownsSession(id: string, key: string, legacy?: LegacySessionIdentity): boolean {
  return scopedSession(id, key) || !!legacy && /^[a-f0-9]{64}$/.test(legacy.key)
    && scopedSession(id, legacy.key) && legacy.sessionIds.includes(id)
}

/** Shared ownership check for native resume, receipt recovery and project metadata. */
export function ownedSessionIds(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object') return []
  const row = value as { sessionId?: unknown; receipts?: unknown; legacyIdentity?: LegacySessionIdentity }
  const ids: unknown[] = [row.sessionId]
  if (Array.isArray(row.receipts)) for (const receipt of row.receipts) {
    if (receipt && typeof receipt === 'object') ids.push((receipt as { sessionId?: unknown }).sessionId)
  }
  const legacy = row.legacyIdentity
  const validLegacy = legacy && typeof legacy.key === 'string' && Array.isArray(legacy.sessionIds) ? legacy : undefined
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && ownsSession(id, key, validLegacy)))]
}

/**
 * Only the legacy key derived from the full configured identity can grant old IDs.
 * Preserve the source row and current journal. Also repairs a row already copied by
 * an earlier build, without granting arbitrary sessions sharing the old prefix.
 */
export function migrateBindingState(binding: Binding, current: BindingState | undefined, previous: BindingState | undefined): BindingState | undefined {
  if (!previous || current?.legacyIdentity) return current
  const row = current ?? previous
  const key = legacyBindingKey(binding)
  const sessionIds = ownedSessionIds({ sessionId: previous.sessionId, receipts: previous.receipts }, key)
  if (!sessionIds.length) return row
  return { ...row, legacyIdentity: { key, sessionIds } }
}

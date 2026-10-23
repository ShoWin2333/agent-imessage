import { createHash } from 'node:crypto'
import type { Binding } from './config.js'

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

import type { PluginErrorCode, PublicPluginError } from './types.js'

import { PluginError } from './transport-error.js'
export { PluginError } from './transport-error.js'

/** Map any internal failure to a redacted UI-safe error. */
export function publicError(error: unknown): PublicPluginError {
  if (error instanceof PluginError) return error.public()

  return {
    code: 'internal-error',
    message: 'Agent iMessage encountered an unexpected error. Retry or check host logs.',
  }
}

/** Assert a condition with a stable public failure. */
export function requireCondition(
  condition: unknown,
  code: PluginErrorCode,
  message: string,
): asserts condition {
  if (!condition) throw new PluginError(code, message)
}

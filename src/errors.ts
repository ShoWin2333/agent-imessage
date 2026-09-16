import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { PluginErrorCode, PublicPluginError } from './types.js'

import { PluginError } from './transport-error.js'
export { PluginError } from './transport-error.js'

/** Map any internal failure to a redacted UI-safe error. */
export function publicError(error: unknown): PublicPluginError {
  if (error instanceof PluginError) return error.public()
  if (error instanceof SettingsConflictError) {
    return {
      code: 'settings-conflict',
      message: 'Settings changed in another window. Refresh and try again.',
    }
  }
  return {
    code: 'internal-error',
    message: 'The iMessage plugin encountered an unexpected error. Retry or check host logs.',
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

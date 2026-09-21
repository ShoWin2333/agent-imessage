import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { PluginErrorCode, PublicPluginError } from './types.js'

/** Internal error carrying an already-redacted public representation. */
export class PluginError extends Error {
  /** Stable public code. */
  readonly code: PluginErrorCode
  /** Optional public-only identifiers. */
  readonly details: string[] | undefined

  /** Construct one safe plugin failure. */
  constructor(code: PluginErrorCode, message: string, details?: string[], options?: ErrorOptions) {
    super(message, options)
    this.name = 'PluginError'
    this.code = code
    this.details = details
  }

  /** Return the JSON-safe public representation. */
  public(): PublicPluginError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: [...this.details] }),
    }
  }
}

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

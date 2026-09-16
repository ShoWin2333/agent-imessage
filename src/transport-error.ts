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


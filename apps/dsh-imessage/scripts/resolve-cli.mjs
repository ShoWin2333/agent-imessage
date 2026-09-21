import { existsSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'

/**
 * Resolve a command for `execFile` on Windows, where PATH shims are `.cmd`.
 * Absolute paths keep their existing extension when present.
 */
export function resolveCli(command) {
  if (process.platform !== 'win32') return command
  if (extname(command)) return command
  const withCmd = `${command}.cmd`
  if (isAbsolute(command)) return existsSync(withCmd) ? withCmd : command
  return withCmd
}

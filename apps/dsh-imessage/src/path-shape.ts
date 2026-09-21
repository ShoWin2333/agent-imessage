/**
 * Shared, runtime-agnostic path helpers.
 * The settings UI runs in the browser, so this module must not import `node:path`.
 */

/** Strip wrapping quotes from Windows Explorer “Copy as path”. */
export function unwrapCopiedPath(input: string): string {
  let value = input.trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1).trim()
    }
  }
  return value
}

/**
 * Accept POSIX, Windows drive-letter, and UNC absolute path shapes.
 * Used by both the host and the browser settings UI.
 */
export function isAbsolutePathShape(value: string): boolean {
  const trimmed = unwrapCopiedPath(value)
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return true
  if (trimmed.startsWith('\\\\')) return true
  return false
}

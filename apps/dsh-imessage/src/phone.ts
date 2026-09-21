import { PluginError } from './errors.js'

const E164 = /^\+[1-9]\d{1,14}$/

/** Trim and strictly validate an E.164 phone number. */
export function normalizeE164(input: string): string {
  const value = input.trim()
  if (!E164.test(value)) {
    throw new PluginError(
      'invalid-phone',
      'Enter a valid E.164 number, including + and country code (for example, +14155550123).',
    )
  }
  return value
}

/** Constant-shape equality after strict E.164 normalization. */
export function samePhone(left: string, right: string): boolean {
  return normalizeE164(left) === normalizeE164(right)
}

import { describe, expect, it } from 'vitest'
// This helper intentionally remains plain ESM because the profile smoke runner is plain Node.
// @ts-expect-error The runtime module does not need a declaration file.
import { parseTrailingJsonArray } from '../scripts/pack-report.mjs'

describe('npm pack JSON report parsing', () => {
  it('accepts clean JSON and npm 10 lifecycle output', () => {
    expect(parseTrailingJsonArray('[{"filename":"plugin.tgz"}]\n')).toEqual([
      { filename: 'plugin.tgz' },
    ])
    expect(parseTrailingJsonArray(
      '\u001B[34mℹ\u001B[39m tsdown build output\n[{"filename":"plugin.tgz"}]\n',
    )).toEqual([{ filename: 'plugin.tgz' }])
  })

  it('rejects output without a trailing JSON array', () => {
    expect(() => parseTrailingJsonArray('build complete\n')).toThrow(
      'npm pack did not return a JSON report',
    )
  })
})

import { describe, expect, it } from 'vitest'
import { resolveCli } from '../scripts/resolve-cli.mjs'

describe('resolveCli', () => {
  it('maps PATH commands to Windows .cmd shims for execFile', () => {
    if (process.platform === 'win32') {
      expect(resolveCli('npm')).toBe('npm.cmd')
      expect(resolveCli('dsh')).toBe('dsh.cmd')
      expect(resolveCli('C:\\tools\\dsh.cmd')).toBe('C:\\tools\\dsh.cmd')
    } else {
      expect(resolveCli('npm')).toBe('npm')
      expect(resolveCli('dsh')).toBe('dsh')
    }
  })
})

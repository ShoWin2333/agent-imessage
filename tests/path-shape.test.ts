import { describe, expect, it } from 'vitest'
import { isAbsolutePathShape, unwrapCopiedPath } from '../src/path-shape.js'

describe('path shape helpers', () => {
  it('unwraps quoted Windows Explorer copy-as-path values', () => {
    expect(unwrapCopiedPath('  "C:\\Users\\me\\app"  ')).toBe('C:\\Users\\me\\app')
    expect(unwrapCopiedPath("'D:/work/app'")).toBe('D:/work/app')
    expect(unwrapCopiedPath('/tmp/project')).toBe('/tmp/project')
  })

  it('accepts POSIX, Windows drive, and UNC absolute shapes', () => {
    expect(isAbsolutePathShape('/tmp/project')).toBe(true)
    expect(isAbsolutePathShape('C:\\Users\\me\\app')).toBe(true)
    expect(isAbsolutePathShape('D:/work/app')).toBe(true)
    expect(isAbsolutePathShape('\\\\server\\share\\repo')).toBe(true)
    expect(isAbsolutePathShape('"C:\\quoted\\path"')).toBe(true)
  })

  it('rejects relative and drive-relative paths', () => {
    expect(isAbsolutePathShape('')).toBe(false)
    expect(isAbsolutePathShape('relative/path')).toBe(false)
    expect(isAbsolutePathShape('relative\\path')).toBe(false)
    expect(isAbsolutePathShape('C:foo')).toBe(false)
  })
})

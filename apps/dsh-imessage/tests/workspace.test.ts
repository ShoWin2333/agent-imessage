import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginError } from '../src/errors.js'
import { normalizePhotonProjectName, resolveWorkspaceCwd } from '../src/workspace.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('workspace routing helpers', () => {
  it('defaults empty Photon project names to dsh and rejects unsafe names', () => {
    expect(normalizePhotonProjectName(undefined)).toBe('dsh')
    expect(normalizePhotonProjectName('  ')).toBe('dsh')
    expect(normalizePhotonProjectName('dsh-laptop-b')).toBe('dsh-laptop-b')
    expect(() => normalizePhotonProjectName('../etc')).toThrow(PluginError)
    expect(() => normalizePhotonProjectName('bad name')).toThrow(PluginError)
  })

  it('resolves blank workspace overrides to process.cwd and validates absolute directories', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-imessage-cwd-'))
    created.push(dir)
    await expect(resolveWorkspaceCwd(undefined, dir)).resolves.toBe(path.resolve(dir))
    await expect(resolveWorkspaceCwd('', dir)).resolves.toBe(path.resolve(dir))
    await expect(resolveWorkspaceCwd(dir)).resolves.toBe(path.resolve(dir))
    await expect(resolveWorkspaceCwd(`"${dir}"`)).resolves.toBe(path.resolve(dir))
    await expect(resolveWorkspaceCwd('relative/path')).rejects.toMatchObject({ code: 'invalid-workspace' })
    await expect(resolveWorkspaceCwd(path.join(dir, 'missing'))).rejects.toMatchObject({
      code: 'invalid-workspace',
    })
  })
})

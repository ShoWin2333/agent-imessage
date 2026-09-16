import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/codex/config.js'
const dirs: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
it('rejects duplicate Photon projects and missing secrets without exposing their values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-config-')); dirs.push(dir)
  const file = join(dir, 'config.json')
  const route = { id: 'one', cwd: dir, projectId: 'p', projectSecretEnv: 'AGENT_TEST_SECRET', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }
  vi.stubEnv('AGENT_TEST_SECRET', '')
  await writeFile(file, JSON.stringify({ stateDir: dir, routes: [route] }))
  await expect(loadConfig(file)).rejects.toThrow('Missing environment variable')
  vi.stubEnv('AGENT_TEST_SECRET', 'not-a-real-key')
  await expect(loadConfig(file)).resolves.toMatchObject({ routes: [{ id: 'one' }] })
  await writeFile(file, JSON.stringify({ stateDir: dir, routes: [route, { ...route, id: 'two' }] }))
  await expect(loadConfig(file)).rejects.toThrow('unique')
})

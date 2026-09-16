import { afterEach, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/codex/state.js'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
const route = { id: 'a', cwd: '/workspace', projectId: 'p', projectSecretEnv: 'SECRET', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }
it('persists thread and replay state, locks duplicates, and isolates changed senders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-')); dirs.push(dir)
  const first = await StateStore.open(dir, route)
  first.state.threadId = 'saved'; first.state.seen.push('m1'); await first.save()
  await expect(StateStore.open(dir, route)).rejects.toThrow()
  await first.close()
  const second = await StateStore.open(dir, route)
  expect(second.state).toEqual({ threadId: 'saved', seen: ['m1'] }); await second.close()
  const third = await StateStore.open(dir, { ...route, senderPhoneNumber: '+15550000000' })
  expect(third.state).toEqual({ seen: [] }); await third.close()
})
it('rejects a publicly readable state directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-')); dirs.push(dir); await chmod(dir, 0o755)
  await expect(StateStore.open(dir, route)).rejects.toThrow('private directory')
})

import { afterEach, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
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

it('isolates Cursor sessions by backend and mode while preserving Codex state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-')); dirs.push(dir)
  const codex = await StateStore.open(dir, route)
  codex.state.threadId = 'codex-thread'; await codex.save(); await codex.close()
  const cursor = await StateStore.open(dir, { ...route, backend: 'cursor' })
  expect(cursor.state.threadId).toBeUndefined()
  cursor.state.threadId = 'cursor-thread'; await cursor.save(); await cursor.close()
  const ask = await StateStore.open(dir, { ...route, backend: 'cursor', cursorMode: 'ask' })
  expect(ask.state.threadId).toBeUndefined(); await ask.close()
  const original = await StateStore.open(dir, { ...route, backend: 'codex' })
  expect(original.state.threadId).toBe('codex-thread'); await original.close()
})

it('reclaims a confirmed dead process lock after a service crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-state-')); dirs.push(dir)
  await mkdir(join(dir, 'a.lock'), { mode: 0o700 })
  await writeFile(join(dir, 'a.lock', 'pid'), '2147483647')
  const store = await StateStore.open(dir, route)
  await store.close()
})

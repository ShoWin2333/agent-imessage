import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, channelDomain, pluginConfigSchema } from '../src/plugin/index.js'
import { bindingKey, legacyBindingKey, migrateBindingState, ownedSessionIds } from '../src/plugin/identity.js'
import { DshNativeHost } from '../src/plugin/native.js'
import { ChannelProjectGroups } from '../src/plugin/project-groups.js'
import type { BindingState } from '../src/plugin/bridge.js'
import type { ChannelMessage } from '../src/channels/types.js'

const transport = vi.hoisted(() => ({ receive: undefined as undefined | ((message: ChannelMessage) => Promise<void>), delivered: [] as ChannelMessage[] }))
const message = (id: string): ChannelMessage => ({ id, text: 'synthetic input', send: vi.fn(async () => {}), responding: fn => fn(), sendFile: vi.fn(), sendVoice: vi.fn() })
vi.mock('../src/channels/telegram.js', () => ({ TelegramAdapter: class {
  constructor(_config: unknown, _store: unknown, receive: typeof transport.receive, private onState: (state: { phase: string }) => void) { transport.receive = receive }
  async start() { this.onState({ phase: 'listening' }) }
  async stop() {}
  async scheduledMessage(id: string) { const result = message(id); transport.delivered.push(result); return result }
} }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); transport.receive = undefined; transport.delivered = [] })

async function fixture() {
  const cwd = await realpath(process.cwd())
  const binding = pluginConfigSchema.parse({ bindings: [{ id: 'jane-telegram', enabled: true, cwd, credentialRef: 'SYNTHETIC_REF', permissionPreset: 'workspace-write', channel: { id: 'jane', kind: 'telegram', botId: '123', ownerUserId: '456' } }] }).bindings[0]!
  const key = bindingKey(binding), oldKey = legacyBindingKey(binding)
  const rows = new Map<string, BindingState>(), adapters = new Map<string, unknown>(), sessions = new Map<string, Session>()
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const emit = (name: string, ...args: any[]) => { for (const fn of handlers.get(name) ?? []) fn(...args) }
  const domain = { table: (name: string) => { const map = name === 'bindings' ? rows : adapters; return { get: (id: string) => map.get(id), put: async (id: string, value: any) => { map.set(id, structuredClone(value)) } } }, close: vi.fn(async () => {}) }
  const follows = vi.fn()
  const handle = (id: string) => {
    const session = sessions.get(id)!, agent = { id: session.id, session, ctx, inbox: { clear: vi.fn() }, cancel: vi.fn(), followup: (input: any) => {
      follows(id, input)
      emit('agent/inbox/claimed', { agent, message: input, turn: 2 })
      emit('session/event', session, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'continued original session' }] } } })
      emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    } }
    return { agent, dispose: vi.fn(async () => {}) }
  }
  let stop!: () => Promise<void>
  const ctx = {
    logger: () => ({ warn: vi.fn() }), get: () => undefined, plugin: vi.fn(), tools: { register: () => () => {} },
    effect: (fn: () => () => Promise<void>) => { stop = fn() },
    on: (name: string, fn: (...args: any[]) => void) => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(fn); return () => handlers.get(name)!.delete(fn) },
    storageDomain: { open: async () => domain, get: () => domain }, credentials: { resolve: async () => ({ value: 'synthetic', source: 'test' }) },
    permissionPresets: { resolve: vi.fn(), set: vi.fn() }, agentPresets: { defaultId: 'synthetic', mount: vi.fn() }, agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'no-model-call' }) },
    sessions: { flush: async () => true },
    agents: { get: () => undefined, create: vi.fn(async (options: any) => { sessions.set(options.sessionId, Session.create(options.sessionId)); return handle(options.sessionId) }), resume: vi.fn(async (options: any) => handle(options.resumeSessionId)) },
    sessionPersistence: { stat: vi.fn(async (id: string) => sessions.has(id) ? { header: { cwd } } : undefined), open: async (id: string) => ({ read: async () => ({ events: sessions.get(id)!.snapshotEvents() }), close: async () => {} }) },
  } as unknown as Context
  // Create through the actual pre-upgrade native host, rather than inventing a new ID.
  const old = await new DshNativeHost(ctx, cwd, binding.permissionPreset, oldKey).open()
  const original = old.id
  await old.close()
  rows.set(oldKey, { sessionId: original, receipts: [] })
  adapters.set(oldKey, { seen: ['original-message'], channelCursor: '42' })
  vi.mocked(ctx.agents.create).mockClear()
  const upgrade = async (credential = binding.credentialRef) => { await apply(ctx, { bindings: [{ ...binding, credentialRef: credential }] }); cleanups.push(stop) }
  return { ctx, binding, key, oldKey, rows, adapters, sessions, original, follows, upgrade }
}

it('continues a pre-upgrade session after migration and another credential rotation without changing its ID', async () => {
  const f = await fixture(); await f.upgrade()
  const input = message('after-upgrade'); await transport.receive!(input)
  await vi.waitFor(() => expect(input.send).toHaveBeenCalledWith('continued original session'))
  expect(f.ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: f.original }))
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
  expect(f.rows.get(f.key)?.sessionId).toBe(f.original)
  expect(f.adapters.get(f.key)).toEqual({ seen: ['original-message'], channelCursor: '42' })
  await cleanups.pop()!()
  await f.upgrade('ROTATED_SYNTHETIC_REF')
  const next = message('after-rotation'); await transport.receive!(next)
  await vi.waitFor(() => expect(next.send).toHaveBeenCalledWith('continued original session'))
  expect(f.follows.mock.calls.map(args => args[0])).toEqual([f.original, f.original])
})

it('recovers a pending old receipt and groups the same original session without replaying its input', async () => {
  const f = await fixture(), session = f.sessions.get(f.original)!
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { id: 'old-input', role: 'user', content: [{ type: 'text', text: 'synthetic old input' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
  session.append('assistant/message', { turn: 1, message: { id: 'old-answer', role: 'assistant', content: [{ type: 'text', text: 'persisted old result' }] } } as never, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  f.rows.set(f.oldKey, { sessionId: f.original, receipts: [{ id: 'old-message', inputId: 'old-input', sessionId: f.original, delivery: 'pending' }] })
  await f.upgrade()
  await vi.waitFor(() => expect(transport.delivered[0]?.send).toHaveBeenCalledWith('persisted old result'))
  expect(f.ctx.agents.resume).not.toHaveBeenCalled(); expect(f.follows).not.toHaveBeenCalled()
  const attachSession = vi.fn(async () => {})
  const groups = new ChannelProjectGroups({ ...f.ctx, workspaceRegistry: { create: async () => ({ id: 'original-project', path: f.binding.cwd, title: 'Jane', attachSession }) } } as any, () => [f.binding])
  await groups.refresh(); await groups.close()
  expect(attachSession).toHaveBeenCalledExactlyOnceWith(f.original)
  expect(f.rows.get(f.key)?.receipts[0]).toMatchObject({ sessionId: f.original, delivery: 'sent' })
})

it('repairs a previously copied row without overwriting its newer receipts or the legacy journal', async () => {
  const f = await fixture(), original = structuredClone(f.rows.get(f.oldKey)!)
  const current = { ...original, receipts: [{ id: 'new-command', inputId: 'new-input', sessionId: f.original, delivery: 'sent' as const }] }
  f.rows.set(f.key, current)
  await f.upgrade()
  expect(f.rows.get(f.key)?.receipts).toEqual(current.receipts)
  expect(f.rows.get(f.oldKey)).toEqual(original)
  const input = message('after-partial-migration'); await transport.receive!(input)
  await vi.waitFor(() => expect(input.send).toHaveBeenCalledWith('continued original session'))
})

it('only grants exact legacy journal IDs; foreign binding, sibling ID and wrong cwd are rejected everywhere', async () => {
  const f = await fixture()
  const foreign = { ...f.binding, channel: { ...f.binding.channel, ownerUserId: '999' } } as typeof f.binding
  const foreignId = `channels-${legacyBindingKey(foreign)}-foreign`
  const siblingId = `channels-${f.oldKey}-not-in-the-old-journal`
  f.sessions.set(foreignId, Session.create(SessionId(foreignId)))
  f.sessions.set(siblingId, Session.create(SessionId(siblingId)))
  // Even a wrong ID accidentally present in the old row cannot become an identity grant.
  const row = f.rows.get(f.oldKey)!
  row.receipts.push({ id: 'foreign', inputId: 'foreign-input', sessionId: foreignId, delivery: 'sent' })
  await f.upgrade()
  const migrated = f.rows.get(f.key)!, host = new DshNativeHost(f.ctx, f.binding.cwd, f.binding.permissionPreset, f.key, undefined, migrated.legacyIdentity)
  const otherHost = new DshNativeHost(f.ctx, f.binding.cwd, foreign.permissionPreset, bindingKey(foreign))
  for (const id of [foreignId, siblingId]) {
    await expect(host.open(id)).rejects.toThrow('mismatch')
    await expect(host.inspect(id, 'unknown')).rejects.toThrow('mismatch')
  }
  await expect(otherHost.open(f.original)).rejects.toThrow('mismatch')
  await expect(otherHost.inspect(f.original, 'unknown')).rejects.toThrow('mismatch')
  expect(ownedSessionIds(migrated, f.key)).toEqual([f.original])
  expect(migrateBindingState(foreign, undefined, row)?.legacyIdentity?.sessionIds).not.toContain(f.original)
  const attachSession = vi.fn(async () => {})
  const groups = new ChannelProjectGroups({ ...f.ctx, workspaceRegistry: { create: async () => ({ id: 'jane', path: f.binding.cwd, title: 'Jane', attachSession }) } } as any, () => [f.binding])
  await groups.sessionCreated(f.original); await groups.close()
  expect(attachSession).toHaveBeenCalledExactlyOnceWith(f.original)
  const wrongCwd = new DshNativeHost(f.ctx, '/different-workspace', f.binding.permissionPreset, f.key, undefined, migrated.legacyIdentity)
  await expect(wrongCwd.open(f.original)).rejects.toThrow('mismatch')
  await expect(wrongCwd.inspect(f.original, 'unknown')).rejects.toThrow('mismatch')
  expect(f.ctx.agents.resume).not.toHaveBeenCalled()
})

it('retains the exact migration grant across native JSON storage shutdown and reopen', async () => {
  const f = await fixture(), row = migrateBindingState(f.binding, undefined, f.rows.get(f.oldKey))!
  const root = await mkdtemp(join(tmpdir(), 'dsh-identity-migration-')), ctx = new Context()
  const storage = await ctx.plugin(Storage)
  let json = await ctx.plugin(storageJson, { root }), domain = await ctx.plugin(storageDomain, { backend: 'json' })
  try {
    const first = await ctx.storageDomain.open(channelDomain)
    await first.table('bindings').put(f.key, row); await first.close()
    await domain.dispose(); await json.dispose()
    json = await ctx.plugin(storageJson, { root }); domain = await ctx.plugin(storageDomain, { backend: 'json' })
    const reopened = await ctx.storageDomain.open(channelDomain)
    try {
      const restored = reopened.table('bindings').get(f.key)!
      expect(restored).toEqual(row)
      expect(ownedSessionIds(restored, f.key)).toEqual([f.original])
      const host = new DshNativeHost(f.ctx, f.binding.cwd, f.binding.permissionPreset, f.key, undefined, restored.legacyIdentity)
      const resumed = await host.open(restored.sessionId); expect(resumed.id).toBe(f.original); await resumed.close()
    } finally { await reopened.close() }
  } finally { await domain.dispose(); await json.dispose(); await storage.dispose(); await rm(root, { recursive: true, force: true }) }
})

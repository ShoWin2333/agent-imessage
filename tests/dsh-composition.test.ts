import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as plugin from '../src/index.js'
import { channelDomain, bindingKey, pluginConfigSchema } from '../src/plugin/index.js'
import { TelegramApi } from '../src/channels/telegram-api.js'

it('loads through real Cordis with native JSON domain, synthetic Telegram ingress/egress and restart dedupe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-composition-')), ctx = new Context()
  const storage = await ctx.plugin(Storage)
  const json = await ctx.plugin(storageJson, { root: dir })
  const domain = await ctx.plugin(storageDomain, { backend: 'json' })
  const creates = vi.fn(async () => ({ agent, dispose: async () => { ctx.emit('agent/disposed', { agent } as never) } }))
  const session = Session.create(SessionId('channels-synthetic'))
  const agent = {
id: session.id, session, inbox: { clear: vi.fn() }, cancel: vi.fn(), followup: vi.fn((input: any) => {
      ctx.emit('agent/inbox/claimed', { agent, message: input, turn: 1 } as never)
      ctx.emit('session/event', session, { type: 'step/start', data: { turn: 1 } } as never)
      ctx.emit('session/event', session, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'offline synthetic reply' }] } } } as never)
      ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as never)
    })
}
  const services = await ctx.plugin((ctx: Context) => {
    ctx.provide('llm', {})
    ctx.provide('agents', { create: creates, get: () => undefined })
    ctx.provide('sessions', { flush: async () => true })
    ctx.provide('sessionPersistence', {})
    ctx.provide('agentPresets', { defaultId: 'synthetic', mount: async () => { } })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic', model: 'no-model-call' }) })
    ctx.provide('permissionPresets', { resolve: () => { }, set: () => { } })
    ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic-token', source: 'test' }) })
  })
  let polled = false
  const request = vi.spyOn(TelegramApi.prototype, 'request').mockImplementation(async (_token, method, _params, signal) => {
    if (method === 'getMe') return { id: 123, is_bot: true }
    if (method !== 'getUpdates') return true
    if (!polled) {
polled = true; return [
        { update_id: 1, message: { message_id: 1, from: { id: 999, is_bot: false }, chat: { id: 999, type: 'private' }, text: 'unauthorized' } },
        { update_id: 2, message: { message_id: 2, from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text: 'synthetic task' } },
        { update_id: 3, message: { message_id: 2, from: { id: 456, is_bot: false }, chat: { id: 456, type: 'private' }, text: 'duplicate task' } },
      ]
}
    return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  })
  const config = { bindings: [{ id: 'tg', enabled:true, cwd: dir, channel: { id: 'tg', kind: 'telegram' as const, botId: '123', ownerUserId: '456' }, credentialRef: 'SYNTHETIC_TOKEN', permissionPreset: 'workspace-write' }] }
  let fiber: Awaited<ReturnType<typeof ctx.plugin>> | undefined
  try {
    fiber = await ctx.plugin(plugin, config)
    await vi.waitFor(() => expect(request.mock.calls.some(c => c[1] === 'sendMessage' && (c[2] as any).text === 'offline synthetic reply')).toBe(true))
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.followup.mock.calls[0]![0].content[0].text).toBe('synthetic task')
    await fiber.dispose()
    // Close/reopen storage itself to verify disk durability, rather than an in-memory snapshot.
    await domain.dispose(); await json.dispose()
    const json2 = await ctx.plugin(storageJson, { root: dir }), domain2 = await ctx.plugin(storageDomain, { backend: 'json' })
    try {
      const opened = await ctx.storageDomain.open(channelDomain)
      const b = { ...pluginConfigSchema.parse(config).bindings[0]!, cwd: await realpath(dir) }
      const row = opened.table('bindings').get(bindingKey(b))
      expect(row?.receipts).toHaveLength(1); expect(row?.receipts[0]?.delivery).toBe('sent')
      expect(opened.table('adapters').get(bindingKey(b))?.channelCursor).toBe('4')
      await opened.close()
      polled = false; request.mockClear()
      fiber = await ctx.plugin(plugin, config)
      await vi.waitFor(() => expect(request.mock.calls.some(c => c[1] === 'getUpdates')).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(agent.followup).toHaveBeenCalledTimes(1)
      expect(request.mock.calls.filter(c => c[1] === 'sendMessage')).toHaveLength(0)
      await fiber.dispose(); fiber = undefined
    } finally { await domain2.dispose(); await json2.dispose() }
  } finally {
    await fiber?.dispose(); await services.dispose(); await domain.dispose(); await json.dispose(); await storage.dispose()
    request.mockRestore(); await rm(dir, { recursive: true, force: true })
  }
})

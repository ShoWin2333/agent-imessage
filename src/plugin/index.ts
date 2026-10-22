import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { Config as NativeConfig } from './schema.js'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { ActivationCleanupError, ChannelManager, ChannelsController } from './management.js'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { IMessageAdapter } from '../channels/imessage.js'
import { TelegramAdapter } from '../channels/telegram.js'
import { WeixinAdapter } from '../channels/weixin.js'
import { DiscordAdapter } from '../channels/discord.js'
import type { RouteState } from '../channels/state.js'
import type { ChannelAdapter } from '../channels/types.js'
import { ChannelBridge } from './bridge.js'
import { wasLegacyMessage } from './legacy-checkpoint.js'
import { DshNativeHost } from './native.js'

export const name = 'dsh-channels'
export const inject = ['agents', 'llm', 'sessions', 'sessionPersistence', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'credentials', 'storageDomain']
export { bindingSchema, pluginConfigSchema } from './config.js'
import { pluginConfigSchema, type Binding } from './config.js'
export type { Binding } from './config.js'
export type Config = z.input<typeof pluginConfigSchema>
// Native Settings owns revisions, persistence and volatile config publication.
export const Config: typeof NativeConfig = NativeConfig
export function bindingKey(binding: Binding): string {
  // Includes account, authorized owner, destination, workspace and permission policy.
  const { enabled: _enabled, ...identity } = binding
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
const receiptSchema = z.object({ id: z.string(), inputId: z.string(), sessionId: z.string(), delivery: z.enum(['pending', 'sending', 'sent', 'uncertain']), result: z.object({ text: z.string(), reason: z.string(), suppressed: z.boolean().optional() }).optional() })
export const channelDomain = defineDomain({
  name: 'dsh_channels_v1', version: 1, tables: {
    bindings: domainTable(z.object({ sessionId: z.string().optional(), receipts: z.array(receiptSchema) })),
    adapters: domainTable(z.object({ seen: z.array(z.string()), legacySeen: z.array(z.string()).max(1024).optional(), channelCursor: z.string().optional(), weixinContext: z.string().optional() })),
  }
})

/** Loading or saving disabled bindings never resolves credentials or starts consumers. */
export async function apply(ctx: Context, config: Config | { bindings: Volatile<Binding[]> } = {}): Promise<void> {
  const read = () => pluginConfigSchema.parse({ bindings: config.bindings && 'get' in config.bindings ? config.bindings.get() : config.bindings ?? [] }).bindings
  const initial = read()
  const domain = await ctx.storageDomain.open(channelDomain)
  let stopped = false
  const manager = new ChannelManager(async (raw, signal, stateChanged) => {
    const ensureActive = () => { if (stopped || signal.aborted) throw new Error('Binding activation cancelled') }
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      ensureActive()
      let abort!: () => void
      const cancelled = new Promise<never>((_, reject) => { abort = () => reject(new Error('Binding activation cancelled')); signal.addEventListener('abort', abort, { once: true }) })
      try { return await Promise.race([promise, cancelled]) } finally { signal.removeEventListener('abort', abort) }
    }
    const binding = { ...raw, cwd: await wait(realpath(raw.cwd)) }
    ensureActive()
    ctx.permissionPresets.resolve(binding.permissionPreset)
    if (binding.model) {
      const models = await wait(ctx.llm.listModels(binding.model.provider))
      const selected = models.find(m => m.id === binding.model!.model)
      if (!selected) throw new Error('Model is not in the host catalog')
      if (binding.model.reasoningEffort) {
        const info = await wait(ctx.llm.resolveModelInfo(binding.model.provider, binding.model.model))
        if (!info.reasoning?.efforts.some(e => e.id === binding.model!.reasoningEffort)) throw new Error('Reasoning effort is not in the host catalog')
      }
    }
    const key = bindingKey(binding), table = domain.table('bindings')
    if (!table.get(key)) await wait(table.put(key, { receipts: [] }))
    ensureActive()
    const bridge = new ChannelBridge(new DshNativeHost(ctx, binding.cwd, binding.permissionPreset, key, binding.model), {
      read: () => table.get(key)!, write: value => table.put(key, value),
    })
    bridge.setConnected(false)
    let adapter: ChannelAdapter | undefined
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => { bridge.setConnected(false); await Promise.all([adapter?.stop(), bridge.close()]) })()
    const abort = () => { void close().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const secret = await wait(ctx.credentials.resolve(credentialRef(binding.credentialRef)))
      ensureActive()
      if (!secret) throw new Error('Channel credential reference is not configured')
      const adapterTable = domain.table('adapters'), stored = adapterTable.get(key)
      const legacySeen = new Set(stored?.legacySeen ?? [])
      const state: RouteState = { seen: [...(stored?.seen ?? [])], ...(stored?.channelCursor === undefined ? {} : { channelCursor: stored.channelCursor }), ...(stored?.weixinContext === undefined ? {} : { weixinContext: stored.weixinContext }) }
      const store = { state, save: async () => { ensureActive(); await adapterTable.put(key, { seen: [...state.seen], legacySeen: [...legacySeen], ...(state.channelCursor === undefined ? {} : { channelCursor: state.channelCursor }), ...(state.weixinContext === undefined ? {} : { weixinContext: state.weixinContext }) }) } }
      let recovery: Promise<void> | undefined
      const recover = () => recovery ??= bridge.recover(id => adapter!.scheduledMessage!(id, '')).catch(() => { recovery = undefined; throw new Error('Channel recovery incomplete') })
      const receive = async (message: Parameters<ChannelBridge['receive']>[0]) => { ensureActive(); if (wasLegacyMessage(legacySeen, message.id)) return; await recover(); ensureActive(); await bridge.receive(message) }
      const onState = (state: { phase: string }) => { bridge.setConnected(!signal.aborted && state.phase === 'listening'); stateChanged(state.phase); if (state.phase === 'listening' && !signal.aborted) void recover().catch(() => {}) }
      const c = binding.channel
      adapter = c.kind === 'imessage' ? new IMessageAdapter({ ...c, projectSecret: secret.value }, receive, onState)
        : c.kind === 'telegram' ? new TelegramAdapter({ ...c, token: secret.value }, store, receive, onState)
          : c.kind === 'discord' ? new DiscordAdapter(c, secret.value, receive, onState)
            : new WeixinAdapter({ accountId: c.accountId, token: secret.value, ...binding.weixin! }, store, receive, onState)
      await wait(adapter.start()); ensureActive()
      return { close: async () => { signal.removeEventListener('abort', abort); await close() } }
    } catch {
      signal.removeEventListener('abort', abort)
      try { await close() } catch { throw new ActivationCleanupError({close}) }
      throw new Error('Binding could not activate')
    }
  })
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => { stopped = true; await manager.close(); await domain.close() })()
  ctx.effect(() => close)
  if (typeof ctx.plugin === 'function') ctx.plugin(ChannelsController, manager)
  if (typeof ctx.get === 'function') {
    const settings = ctx.get('settings')
    if (settings) ctx.effect(() => settings.configure({ auto: false }))
  }
  if (typeof ctx.on === 'function') ctx.on('loader/volatile-update', () => {
    // Invalid external settings must never interrupt an accepted running binding.
    try { const next = read(); void manager.update(next).catch(() => {}) }
    catch { manager.rejectConfiguration() }
  })
  await manager.update(initial)
}

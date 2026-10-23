import { realpath } from 'node:fs/promises'
import { Config as NativeConfig } from './schema.js'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-user-approval'
import { BindingActivationError, ActivationCleanupError, ChannelManager, ChannelsController } from './management.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ChannelAdapter } from '../channels/types.js'
import type { RouteState } from '../channels/state.js'
import { ChannelBridge } from './bridge.js'
import { bindingKey, legacyBindingKey } from './identity.js'
import { wasLegacyMessage } from './legacy-checkpoint.js'
import { DshNativeHost } from './native.js'
import { channelStatusTool } from './tool.js'
import { pluginConfigSchema, type Binding } from './config.js'

export const name = 'dsh-channels'
export const inject = ['agents', 'llm', 'sessions', 'sessionPersistence', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'credentials', 'storageDomain', 'tools']
export { bindingSchema, pluginConfigSchema } from './config.js'
export { bindingKey } from './identity.js'
export type { Binding } from './config.js'
export type Config = z.input<typeof pluginConfigSchema>
// Native Settings owns revisions, persistence and volatile config publication.
export const Config: typeof NativeConfig = NativeConfig
const receiptSchema = z.object({ id: z.string(), inputId: z.string(), sessionId: z.string(), delivery: z.enum(['pending', 'sending', 'sent', 'uncertain']), result: z.object({ text: z.string(), reason: z.string(), suppressed: z.boolean().optional() }).optional() })
export const channelDomain = defineDomain({
  name: 'dsh_channels_v1', version: 1, tables: {
    bindings: domainTable(z.object({ sessionId: z.string().optional(), receipts: z.array(receiptSchema) })),
    adapters: domainTable(z.object({ seen: z.array(z.string()), legacySeen: z.array(z.string()).max(1024).optional(), channelCursor: z.string().optional(), weixinContext: z.string().optional() })),
  }
})

/** Loading or saving disabled bindings never resolves credentials or starts consumers. */
export async function apply(ctx: Context, config: Config | { bindings: Volatile<Binding[]> } = {}): Promise<void> {
  const log = ctx.logger('agent-imessage')
  const report = (message: string, details?: unknown) => { log.warn(message); if (details !== undefined) log.warn(details) }
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
    let cwd: string
    try { cwd = await wait(realpath(raw.cwd)) }
    catch (error) { if (signal.aborted) throw error; throw new BindingActivationError('workspace-missing', 'Channel workspace is not an existing directory', { cause: error }) }
    const binding = { ...raw, cwd }
    ensureActive()
    try { ctx.permissionPresets.resolve(binding.permissionPreset) }
    catch (error) { throw new BindingActivationError('preset-missing', 'Permission preset is not configured in the host', { cause: error }) }
    if (binding.model) {
      const models = await wait(ctx.llm.listModels(binding.model.provider)).catch(error => { throw new BindingActivationError('model-missing', 'Model provider is not available in the host catalog', { cause: error }) })
      const selected = models.find(m => m.id === binding.model!.model)
      if (!selected) throw new BindingActivationError('model-missing', 'Model is not in the host catalog')
      if (binding.model.reasoningEffort) {
        const info = await wait(ctx.llm.resolveModelInfo(binding.model.provider, binding.model.model))
        if (!info.reasoning?.efforts.some(e => e.id === binding.model!.reasoningEffort)) throw new BindingActivationError('model-missing', 'Reasoning effort is not in the host catalog')
      }
    }
    const key = bindingKey(binding), legacyKey = legacyBindingKey(binding), table = domain.table('bindings'), adapterTable = domain.table('adapters')
    // Carry a row created before credential rotation was excluded from binding identity.
    if (key !== legacyKey) {
      if (!table.get(key)) { const previous = table.get(legacyKey); if (previous) await wait(table.put(key, previous)) }
      if (!adapterTable.get(key)) { const previous = adapterTable.get(legacyKey); if (previous) await wait(adapterTable.put(key, previous)) }
    }
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
      if (!secret) throw new BindingActivationError('credential-missing', 'Channel credential reference is not configured')
      const stored = adapterTable.get(key)
      const legacySeen = new Set(stored?.legacySeen ?? [])
      const state: RouteState = { seen: [...(stored?.seen ?? [])], ...(stored?.channelCursor === undefined ? {} : { channelCursor: stored.channelCursor }), ...(stored?.weixinContext === undefined ? {} : { weixinContext: stored.weixinContext }) }
      const store = { state, save: async () => { ensureActive(); await adapterTable.put(key, { seen: [...state.seen], legacySeen: [...legacySeen], ...(state.channelCursor === undefined ? {} : { channelCursor: state.channelCursor }), ...(state.weixinContext === undefined ? {} : { weixinContext: state.weixinContext }) }) } }
      let recovery: Promise<void> | undefined
      const recover = () => recovery ??= bridge.recover(id => adapter!.scheduledMessage!(id, '')).catch(error => { recovery = undefined; throw new BindingActivationError('activation-failed', 'Channel recovery incomplete', { cause: error }) })
      const receive = async (message: Parameters<ChannelBridge['receive']>[0]) => { ensureActive(); if (wasLegacyMessage(legacySeen, message.id)) return; await recover(); ensureActive(); await bridge.receive(message) }
      const onState = (state: { phase: string }) => { bridge.setConnected(!signal.aborted && state.phase === 'listening'); stateChanged(state.phase); if (state.phase === 'listening' && !signal.aborted) void recover().catch(() => {}) }
      const c = binding.channel
      // Adapters load on demand: a Telegram-only deployment never imports Discord or Spectrum.
      if (c.kind === 'imessage') {
        const { IMessageAdapter } = await import('../channels/imessage.js')
        adapter = new IMessageAdapter({ ...c, projectSecret: secret.value }, receive, onState)
      } else if (c.kind === 'telegram') {
        const { TelegramAdapter } = await import('../channels/telegram.js')
        adapter = new TelegramAdapter({ ...c, token: secret.value }, store, receive, onState)
      } else if (c.kind === 'discord') {
        const { DiscordAdapter } = await import('../channels/discord.js')
        adapter = new DiscordAdapter(c, secret.value, receive, onState)
      } else {
        const { WeixinAdapter } = await import('../channels/weixin.js')
        adapter = new WeixinAdapter({ accountId: c.accountId, token: secret.value, ...binding.weixin! }, store, receive, onState)
      }
      await wait(adapter.start()); ensureActive()
      return { close: async () => { signal.removeEventListener('abort', abort); await close() } }
    } catch (error) {
      signal.removeEventListener('abort', abort)
      try { await close() } catch { throw new ActivationCleanupError({ close }) }
      if (signal.aborted) throw error
      throw error instanceof BindingActivationError ? error : new BindingActivationError('activation-failed', 'Binding could not activate', { cause: error })
    }
  }, report)
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => { stopped = true; await manager.close(); await domain.close() })()
  ctx.effect(() => ctx.tools.register(channelStatusTool({
    status: () => manager.status(),
    enabled: () => new Set(manager.bindings().filter(binding => binding.enabled).map(binding => binding.id)),
  })))
  ctx.effect(() => close)
  ctx.plugin(ChannelsController, manager)
  const settings = ctx.get('settings')
  if (settings) ctx.effect(() => settings.configure({ auto: false }))
  ctx.on('loader/volatile-update', () => {
    // Invalid external settings must never interrupt an accepted running binding.
    try { const next = read(); void manager.update(next).catch(() => {}) }
    catch { manager.rejectConfiguration() }
  })
  await manager.update(initial)
}

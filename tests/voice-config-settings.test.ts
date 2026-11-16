import {it,expect,vi} from 'vitest'
import {pluginConfigSchema} from '../src/plugin/config.js'
import {DEFAULT_VOICE_CONFIG} from '../src/plugin/voice/settings.js'
import {Config} from '../src/plugin/schema.js'

/** Mirrors how native Settings serializes the declarative config for the browser. */
const binding = () => ({ id: 'qqbot-1', enabled: true, cwd: '/tmp/work', credentialRef: 'QQBOT_KEY', permissionPreset: 'default', channel: { id: 'qqbot-1', kind: 'qqbot' as const, appId: '1234', ownerUserId: 'owner1234' } })

it('persists the deployment-wide voice section without touching bindings or agents', async () => {
  const { SettingsForms } = await import('@deepseek-ai/dsh-settings')
  const rows = [binding()]
  const agents = [{ id: 'agent-1', name: 'Main', cwd: '/tmp/work', bindingIds: [rows[0]!.id] }]
  let raw: Record<string, unknown> = { bindings: rows, agents }
  const entry = { options: { id: 'dsh-channels' }, fiber: { runtime: { Config } } }
  const edit = vi.fn(async (_entry: unknown, change: (current: unknown, inherited: unknown) => Record<string, unknown>) => {
    raw = pluginConfigSchema.parse(change(raw, {}))
  })
  const native = Object.create(SettingsForms.prototype)
  Object.assign(native, {
    ownerContext: { configEditor: { entries: () => [entry], edit } },
    describe: () => [{ ns: 'dsh-channels', revision: 7 }],
  })

  const voice = { ...DEFAULT_VOICE_CONFIG, enabled: true, credentialRef: 'CHANNELS_OPENAI_API_KEY', model: 'gpt-audio-mini', voice: 'nova' }
  await native.mutate('dsh-channels', [{ op: 'set', path: ['voice'], value: voice }], 7)

  expect(edit).toHaveBeenCalledOnce()
  expect(raw.voice).toEqual(voice)
  // The speech section is independent of channel rows: parsing applies the usual
  // defaults, but nothing in those sections changed.
  const normalised = pluginConfigSchema.parse({ bindings: rows, agents })
  expect(raw.bindings).toEqual(normalised.bindings)
  expect(raw.agents).toEqual(normalised.agents)
})

it('rejects a voice section the host schema does not accept', async () => {
  const { SettingsForms } = await import('@deepseek-ai/dsh-settings')
  let raw: Record<string, unknown> = { bindings: [], agents: [] }
  const entry = { options: { id: 'dsh-channels' }, fiber: { runtime: { Config } } }
  const edit = vi.fn(async (_entry: unknown, change: (current: unknown, inherited: unknown) => Record<string, unknown>) => {
    raw = pluginConfigSchema.parse(change(raw, {}))
  })
  const native = Object.create(SettingsForms.prototype)
  Object.assign(native, {
    ownerContext: { configEditor: { entries: () => [entry], edit } },
    describe: () => [{ ns: 'dsh-channels', revision: 7 }],
  })
  // A base URL that is not http(s) would send audio nowhere useful.
  await expect(native.mutate('dsh-channels', [{ op: 'set', path: ['voice'], value: { ...DEFAULT_VOICE_CONFIG, baseURL: 'not-a-url' } }], 7)).rejects.toThrow()
  expect(raw.voice).toBeUndefined()
})

it('applies defaults for a config written before the voice section existed', () => {
  const parsed = pluginConfigSchema.parse({ bindings: [binding()], agents: [] })
  expect(parsed.voice).toEqual(DEFAULT_VOICE_CONFIG)
  expect(parsed.voice.enabled).toBe(false)
  expect(parsed.voice.model).toBe('gpt-audio')
  expect(parsed.voice.speechModel).toBe('gpt-4o-mini-tts')
  expect(parsed.voice.replyMode).toBe('text')
})

it('accepts a volatile voice handle and restarts consumers when speech settings change', async () => {
  const { apply } = await import('../src/plugin/index.js')
  const { ChannelManager } = await import('../src/plugin/management.js')
  const { resolveAgentGroups } = await import('../src/shared/agents.js')
  const rows = [{ ...binding(), enabled: false }]
  let agents = resolveAgentGroups(rows)
  let voice = { ...DEFAULT_VOICE_CONFIG }
  const update = vi.spyOn(ChannelManager.prototype, 'update')
  const handlers = new Map<string, () => void>()
  const releases: Array<() => Promise<void>> = []
  const ctx = {
    logger: () => ({ warn: () => {} }), plugin: () => {}, get: () => undefined,
    on: (name: string, fn: () => void) => { handlers.set(name, fn) },
    tools: { register: () => () => {} },
    storageDomain: { open: async () => ({ close: async () => {} }) },
    effect: (fn: () => () => Promise<void>) => { releases.push(fn()) },
  }
  try {
    // Native Settings publishes volatile handles; the first activation must not
    // treat a speech change as "no change" and must not throw on the handle.
    await apply(ctx as never, { bindings: { get: () => rows }, agents: { get: () => agents }, voice: { get: () => voice } } as never)
    // Parsing fills schema defaults, so compare against the parsed rows.
    const parsedRows = pluginConfigSchema.parse({ bindings: rows, agents }).bindings
    expect(update).toHaveBeenLastCalledWith(parsedRows)

    voice = { ...voice, enabled: true, credentialRef: 'CHANNELS_OPENAI_API_KEY' }
    handlers.get('loader/volatile-update')!()
    // A speech change is not part of a binding fingerprint, so every live
    // consumer is restarted explicitly.
    expect(update).toHaveBeenLastCalledWith(parsedRows, true)

    // A channel-only change must not restart consumers for speech reasons.
    agents = []
    handlers.get('loader/volatile-update')!()
    expect(update).toHaveBeenLastCalledWith(parsedRows, false)
  } finally {
    for (const release of releases.reverse()) await release()
    update.mockRestore()
  }
})

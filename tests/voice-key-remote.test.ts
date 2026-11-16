import {it,expect,vi} from 'vitest'
import {ChannelsController} from '../src/plugin/management.js'

const controllerWith = (overrides: { set?: (ref: string, value: string) => Promise<void>; describe?: () => Promise<{ configured: boolean }>; update?: () => Promise<void> } = {}) => {
  const set = vi.fn(overrides.set ?? (async () => {}))
  const describe = vi.fn(overrides.describe ?? (async () => ({ configured: true })))
  const update = vi.fn(overrides.update ?? (async () => {}))
  const live = [{ id: 'qqbot-628b04a6', enabled: true, channel: { kind: 'qqbot' } }]
  const manager = { update, bindings: () => live, status: () => ({ bindings: [] }) }
  const controller = Object.create(ChannelsController.prototype) as ChannelsController
  Object.assign(controller, { host: { credentials: { set, describe } }, manager })
  return { controller, set, describe, update, live }
}

it('stores the speech key and restarts live consumers so it takes effect immediately', async () => {
  const { controller, set, update, live } = controllerWith()
  await controller.voiceKey('CHANNELS_OPENAI_API_KEY', '  sk-test  ')
  expect(set).toHaveBeenCalledOnce()
  // The value is trimmed; the reference is passed through unchanged.
  expect(set.mock.calls[0]![1]).toBe('sk-test')
  expect(String(set.mock.calls[0]![0])).toBe('CHANNELS_OPENAI_API_KEY')
  expect(update).toHaveBeenCalledWith(live, true)
})

it('refuses a malformed reference or an empty key before touching the credential store', async () => {
  const { controller, set, update } = controllerWith()
  await expect(controller.voiceKey('bad ref', 'sk-test')).rejects.toThrow(/credential reference/)
  await expect(controller.voiceKey('CHANNELS_OPENAI_API_KEY', '   ')).rejects.toThrow(/empty/)
  expect(set).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
})

it('reports configured state without ever returning the value', async () => {
  const configured = controllerWith({ describe: async () => ({ configured: true }) })
  expect(await configured.controller.voiceKeyStatus('CHANNELS_OPENAI_API_KEY')).toEqual({ configured: true })
  const missing = controllerWith({ describe: async () => ({ configured: false }) })
  expect(await missing.controller.voiceKeyStatus('CHANNELS_OPENAI_API_KEY')).toEqual({ configured: false })
  // An invalid reference is reported as unconfigured, never as an error carrying details.
  expect(await missing.controller.voiceKeyStatus('nope nope')).toEqual({ configured: false })
})

import { describe, expect, it, vi } from 'vitest'
import { ImessageSettingsController } from '../src/client/controller.js'
import type { ImessagePluginState, MutationResult } from '../src/types.js'

function state(phase: 'disconnected' | 'pending'): ImessagePluginState {
  return {
    revision: 1,
    settingsWritable: true,
    credentialConfigured: false,
    credentialWritable: true,
    authorization: phase === 'disconnected'
      ? { phase }
      : {
        phase,
        userCode: 'CODE',
        verificationUri: 'https://app.photon.codes/device',
        expiresAt: Date.now() + 60_000,
      },
    provisioning: { phase: 'idle' },
    routes: [{
      id: 'default',
      label: 'dsh',
      workspaceCwd: '/workspace',
      photonProjectName: 'dsh',
      runtime: { phase: 'stopped' },
    }],
  }
}

function success(value: ImessagePluginState): { ok: true; value: MutationResult } {
  return { ok: true, value: { ok: true, state: value } }
}

describe('iMessage settings controller concurrency', () => {
  it('does not let an older polling response overwrite a mutation result', async () => {
    let resolveRefresh!: (value: { ok: true; value: ImessagePluginState }) => void
    const getState = vi.fn(() => new Promise<{ ok: true; value: ImessagePluginState }>(resolve => {
      resolveRefresh = resolve
    }))
    const api = {
      getState,
      beginAuthorization: vi.fn(async () => success(state('pending'))),
      cancelAuthorization: vi.fn(),
      upsertRoute: vi.fn(),
      removeRoute: vi.fn(),
      saveRoutePhone: vi.fn(),
      disconnect: vi.fn(),
      retryRouteRuntime: vi.fn(),
    }
    const controller = new ImessageSettingsController(api as never)
    const unsubscribe = controller.subscribe(() => {})
    await expect(controller.beginAuthorization()).resolves.toMatchObject({ ok: true })
    resolveRefresh({ ok: true, value: state('disconnected') })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.getSnapshot().state?.authorization.phase).toBe('pending')
    unsubscribe()
    controller.dispose()
  })

  it('allows only one browser mutation at a time', async () => {
    let resolve!: (value: ReturnType<typeof success>) => void
    const beginAuthorization = vi.fn(() => new Promise<ReturnType<typeof success>>(done => { resolve = done }))
    const api = {
      getState: vi.fn(async () => ({ ok: true as const, value: state('disconnected') })),
      beginAuthorization,
      cancelAuthorization: vi.fn(),
      upsertRoute: vi.fn(),
      removeRoute: vi.fn(),
      saveRoutePhone: vi.fn(),
      disconnect: vi.fn(),
      retryRouteRuntime: vi.fn(),
    }
    const controller = new ImessageSettingsController(api as never)
    const first = controller.beginAuthorization()
    await expect(controller.beginAuthorization()).resolves.toBeUndefined()
    expect(beginAuthorization).toHaveBeenCalledOnce()
    resolve(success(state('pending')))
    await expect(first).resolves.toMatchObject({ ok: true })
    controller.dispose()
  })
})

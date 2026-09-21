// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ImessagePluginState, ImessageRouteState, MutationResult } from '../src/types.js'
import { ImessageSettingsController } from '../src/client/controller.js'
import { ImessageSettingsSection } from '../src/client/ImessageSettingsSection.js'
import { inject, settingsInject } from '../src/client/injections.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function defaultRoute(overrides: Partial<ImessageRouteState> = {}): ImessageRouteState {
  return {
    id: 'default',
    label: 'dsh',
    workspaceCwd: '/workspace',
    photonProjectName: 'dsh',
    runtime: { phase: 'stopped' },
    ...overrides,
  }
}

function pluginState(overrides: Partial<ImessagePluginState> = {}): ImessagePluginState {
  return {
    revision: 7,
    settingsWritable: true,
    credentialConfigured: false,
    credentialWritable: true,
    authorization: { phase: 'disconnected' },
    provisioning: { phase: 'idle' },
    routes: [defaultRoute()],
    ...overrides,
  }
}

function success(state: ImessagePluginState): { ok: true; value: MutationResult } {
  return { ok: true, value: { ok: true, state } }
}

function remote(initial: ImessagePluginState) {
  return {
    getState: vi.fn(async () => ({ ok: true as const, value: initial })),
    beginAuthorization: vi.fn(async () => success(initial)),
    cancelAuthorization: vi.fn(async () => success(initial)),
    upsertRoute: vi.fn(async () => success(initial)),
    removeRoute: vi.fn(async () => success(initial)),
    saveRoutePhone: vi.fn(async () => success(initial)),
    disconnect: vi.fn(async () => success(initial)),
    retryRouteRuntime: vi.fn(async () => success(initial)),
  }
}

function renderState(initial: ImessagePluginState) {
  const api = remote(initial)
  const controller = new ImessageSettingsController(api as never)
  render(<ImessageSettingsSection controller={controller} />)
  return { api, controller }
}

describe('Settings > iMessage', () => {
  it('mounts the Remote contribution before waiting on its nested face', () => {
    expect(inject).toEqual(['remote'])
    expect(settingsInject).toEqual(['slots', 'remote.dshPhotonImessage'])
  })

  it('opens a blank device-login window synchronously, then navigates it and shows expiry/cancel', async () => {
    const initial = pluginState()
    const pending = pluginState({
      authorization: {
        phase: 'pending',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://app.photon.codes/device',
        verificationUriComplete: 'https://app.photon.codes/device?user_code=ABCD-EFGH',
        expiresAt: Date.now() + 600_000,
      },
    })
    const { api } = renderState(initial)
    let complete!: (value: ReturnType<typeof success>) => void
    api.beginAuthorization.mockImplementation(() => new Promise(resolve => { complete = resolve }))
    api.cancelAuthorization.mockResolvedValue(success(initial))
    const replace = vi.fn()
    const close = vi.fn()
    const popup = {
      closed: false,
      opener: window,
      location: { replace },
      document: { title: '', body: { textContent: '' } },
      close,
    }
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const user = userEvent.setup()

    await screen.findByRole('button', { name: 'Authorize' })
    await user.click(screen.getByRole('button', { name: 'Authorize' }))
    expect(open).toHaveBeenCalledWith('about:blank', expect.any(String), expect.any(String))
    expect(api.beginAuthorization).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()

    complete(success(pending))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(replace).toHaveBeenCalledWith('https://app.photon.codes/device?user_code=ABCD-EFGH')
    expect(screen.getByText(/Expires in/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.cancelAuthorization).toHaveBeenCalledOnce()
  })

  it('saves workspace routing for local cwd and Photon project name', async () => {
    const initial = pluginState()
    const saved = pluginState({
      revision: 8,
      routes: [defaultRoute({ workspaceCwd: '/tmp', photonProjectName: 'dsh-laptop-b' })],
    })
    const { api } = renderState(initial)
    api.upsertRoute.mockResolvedValue(success(saved))
    const user = userEvent.setup()

    const cwd = await screen.findByLabelText('Local project directory')
    const project = screen.getByLabelText('Photon project name')
    await user.clear(cwd)
    await user.type(cwd, '/tmp')
    await user.clear(project)
    await user.type(project, 'dsh-laptop-b')
    await user.click(screen.getByRole('button', { name: 'Save route' }))

    await waitFor(() => {
      expect(api.upsertRoute).toHaveBeenCalledWith({
        id: 'default',
        label: 'dsh',
        workspaceCwd: '/tmp',
        photonProjectName: 'dsh-laptop-b',
        expectedRevision: 7,
      })
    })
    expect(await screen.findByDisplayValue('/tmp')).toBeTruthy()
    expect(screen.getByDisplayValue('dsh-laptop-b')).toBeTruthy()
  })

  it('accepts a Windows drive-letter workspace path', async () => {
    const initial = pluginState()
    const saved = pluginState({
      revision: 8,
      routes: [defaultRoute({ workspaceCwd: 'D:\\work\\app', photonProjectName: 'dsh' })],
    })
    const { api } = renderState(initial)
    api.upsertRoute.mockResolvedValue(success(saved))
    const user = userEvent.setup()

    const cwd = await screen.findByLabelText('Local project directory')
    await user.clear(cwd)
    await user.type(cwd, String.raw`D:\work\app`)
    await user.click(screen.getByRole('button', { name: 'Save route' }))

    await waitFor(() => {
      expect(api.upsertRoute).toHaveBeenCalledWith({
        id: 'default',
        label: 'dsh',
        workspaceCwd: 'D:\\work\\app',
        photonProjectName: 'dsh',
        expectedRevision: 7,
      })
    })
  })

  it('validates E.164, provisions a sender, and renders the assigned sms link', async () => {
    const initial = pluginState({
      credentialConfigured: true,
      authorization: {
        phase: 'authorized',
        account: { id: 'account', email: 'ada@example.com', name: 'Ada' },
        expiresAt: Date.now() + 3_600_000,
      },
      provisioning: { phase: 'ready', project: { id: 'project', name: 'dsh' } },
    })
    const ready = pluginState({
      ...initial,
      revision: 8,
      routes: [defaultRoute({
        phoneNumber: '+14155552671',
        assignedPhoneNumber: '+14155550000',
        runtime: { phase: 'listening', connectedAt: Date.now() },
      })],
    })
    const { api } = renderState(initial)
    api.saveRoutePhone.mockResolvedValue(success(ready))
    const user = userEvent.setup()
    const input = await screen.findByLabelText('Number you will text from')

    await user.type(input, '415 555 2671')
    expect(screen.getByText(/Use “\+” followed/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save number' }).hasAttribute('disabled')).toBe(true)
    await user.clear(input)
    await user.type(input, '+14155552671')
    await user.click(screen.getByRole('button', { name: 'Save number' }))

    await waitFor(() => {
      expect(api.saveRoutePhone).toHaveBeenCalledWith({
        routeId: 'default',
        phoneNumber: '+14155552671',
        expectedRevision: 7,
      })
    })
    expect(await screen.findByText('+14155550000')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Text this number' }).getAttribute('href')).toBe('sms:+14155550000')
    expect(screen.getAllByText('Listening')).toHaveLength(2)
  })

  it('surfaces optimistic conflicts and reauthorization-required state', async () => {
    const initial = pluginState({
      credentialConfigured: true,
      authorization: {
        phase: 'reauthorization-required',
        account: { id: 'account', email: 'ada@example.com' },
      },
      provisioning: { phase: 'ready', project: { id: 'project', name: 'dsh' } },
      routes: [defaultRoute({
        phoneNumber: '+14155552671',
        assignedPhoneNumber: '+14155550000',
      })],
    })
    renderState(initial)
    expect(await screen.findByText(/Management authorization expired/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reauthorize' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save number' }).hasAttribute('disabled')).toBe(true)

    cleanup()
    const authorized = pluginState({
      credentialConfigured: true,
      authorization: {
        phase: 'authorized', account: { id: 'account', email: 'ada@example.com' }, expiresAt: Date.now() + 60_000,
      },
      provisioning: { phase: 'ready', project: { id: 'project', name: 'dsh' } },
    })
    const { api } = renderState(authorized)
    api.saveRoutePhone.mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        error: { code: 'settings-conflict', message: 'Settings changed in another window. Refresh and try again.' },
        state: authorized,
      },
    })
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Number you will text from'), '+14155552671')
    await user.click(screen.getByRole('button', { name: 'Save number' }))
    expect(await screen.findByText('Settings changed in another window. Refresh and try again.')).toBeTruthy()
  })

  it('retries a failed listener and disconnects while warning that cloud resources remain', async () => {
    const failed = pluginState({
      credentialConfigured: true,
      authorization: {
        phase: 'authorized', account: { id: 'account', email: 'ada@example.com' }, expiresAt: Date.now() + 60_000,
      },
      provisioning: { phase: 'ready', project: { id: 'project', name: 'dsh' } },
      routes: [defaultRoute({
        phoneNumber: '+14155552671',
        assignedPhoneNumber: '+14155550000',
        runtime: {
          phase: 'failed',
          error: { code: 'runtime-failed', message: 'The hosted line could not connect.' },
        },
      })],
    })
    const listening = pluginState({
      ...failed,
      routes: [defaultRoute({
        phoneNumber: '+14155552671',
        assignedPhoneNumber: '+14155550000',
        runtime: { phase: 'listening', connectedAt: Date.now() },
      })],
    })
    const disconnected = pluginState()
    const { api } = renderState(failed)
    api.retryRouteRuntime.mockResolvedValue(success(listening))
    api.disconnect.mockResolvedValue(success(disconnected))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: 'Retry listener' }))
    expect(api.retryRouteRuntime).toHaveBeenCalledWith({ routeId: 'default' })
    await screen.findAllByText('Listening')
    await user.click(screen.getByRole('button', { name: 'Disconnect all routes' }))
    expect(window.confirm).toHaveBeenCalledWith(
      'Disconnect all local iMessage routes? Photon projects and users will be preserved.',
    )
    expect(api.disconnect).toHaveBeenCalledWith({ expectedRevision: 7 })
    expect(await screen.findByText(/Your hosted iMessage number appears here after the sender is saved/)).toBeTruthy()
  })
})

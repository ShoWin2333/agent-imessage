// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Context, Service } from '@deepseek-ai/cordis'
import { installPanel } from '../src/client/bootstrap.js'
import { fallbackTranslate } from '../src/client/locale.js'
import type { ClientContext } from '../src/client/contracts.js'
import type { ComponentType } from 'react'

it.each(['unary','stream'] as const)('mounts the %s settings view with both generated remote namespaces in a real Cordis scope', async mode => {
  const root = new Context()
  const status = vi.fn(async () => ({ ok: true, value: { bindings: [{ id: 'jane-weixin', phase: 'listening' }] } }))
  const projectStatus = vi.fn(async () => ({ ok: true, value: { projects: [{ id: 'project', title: 'Jane', cwd: '/synthetic/jane', bindingIds: ['jane-weixin'] }], pending: [], errors: [] } }))
  const namespaces = { channels: { status }, projects: { status: projectStatus } }
  let streamClosed = false
  if (mode === 'stream') Object.assign(namespaces.channels, { async *statusStream(signal: AbortSignal) {
    try {
      yield { bindings: [{ id: 'jane-weixin', phase: 'listening' }] }
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    } finally { streamClosed = true }
  } })
  class Remote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote') }
    async $mount() { return async () => {} }
    get channels() { return (this.ctx as any)['remote.channels'] }
    get channelProjects() { return (this.ctx as any)['remote.channelProjects'] }
    get session() { return (this.ctx as any)['remote.session'] }
  }
  const getForm = vi.fn(() => form)
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {}, mutate: vi.fn(),
  }
  const snapshot = { status: 'ready', revision: 1, writable: true, value: { bindings: [{ id: 'jane-weixin', enabled: true, cwd: '/synthetic/jane', credentialRef: 'SYNTHETIC_REF', permissionPreset: 'workspace-write', channel: { id: 'jane', kind: 'weixin', accountId: 'synthetic' }, weixin: { ownerUserId: 'owner', baseUrl: 'https://example.invalid' } }] } }
  let registration: { options: { inject(): any }; component: ComponentType<any> } | undefined
  let remoteUnmounted = 0
  const services = await root.plugin((ctx: Context) => {
    ctx.provide('remote.channels' as any, namespaces.channels)
    ctx.provide('remote.channelProjects' as any, namespaces.projects)
    ctx.provide('remote.session' as any, { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'synthetic', model: 'no-call' }, groups: [], failures: [] } }) })
    ctx.provide('configForms' as any, { get: getForm, whileServed: (_ids: unknown, register: () => () => void) => register() })
    ctx.provide('uiWorkspace' as any, { pickDirectory: vi.fn() })
    ctx.provide('slots' as any, { inject: (_slot: unknown, register: () => () => void) => register(), register: (options: any, component: ComponentType<any>) => { registration = { options, component }; return () => { registration = undefined; remoteUnmounted++ } } })
    ctx.provide('locale' as any, { register: () => () => {}, bind: () => fallbackTranslate, subscribe: () => () => {} })
  })
  const remote = await root.plugin(Remote)
  const panel = await root.plugin({
    inject: ['remote', 'remote.session', 'slots', 'configForms', 'uiWorkspace', 'locale'],
    async apply(ctx: Context) { return installPanel(ctx as unknown as ClientContext, {}) },
  })
  try {
    expect(registration).toBeDefined()
    expect(getForm).toHaveBeenCalledWith('dsh-channels')
    const props = registration!.options.inject()
    expect(() => props.ctx.remote.channels).not.toThrow()
    expect(() => props.ctx.remote.channelProjects).not.toThrow()
    expect(props.ctx.remote.channels).toBe(namespaces.channels)
    const View = registration!.component
    render(<View {...props} />)
    await screen.findByText('已连接')
    await screen.findByText(/DSH 项目：Jane · project/)
    expect(status).toHaveBeenCalledTimes(mode === 'stream' ? 0 : 1)
    expect(projectStatus).toHaveBeenCalledTimes(1)
    expect(form.mutate).not.toHaveBeenCalled()
  } finally { cleanup(); await panel.dispose(); await remote.dispose(); await services.dispose() }
  expect(remoteUnmounted).toBe(1)
  if (mode === 'stream') expect(streamClosed).toBe(true)
})

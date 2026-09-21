import { describe, expect, it, vi } from 'vitest'
import {
  createPhotonManagementApi,
  deriveNames,
  ensureDshProject,
  ensureSharedUser,
  type PhotonManagementApi,
  type PhotonProject,
  type PhotonSpectrumUser,
} from '../src/photon-management.js'
import { PluginError } from '../src/errors.js'

function management(overrides: Partial<PhotonManagementApi> = {}): PhotonManagementApi {
  return {
    listProjects: vi.fn(async () => []),
    getProject: vi.fn(async () => undefined),
    createProject: vi.fn(async () => 'created-project'),
    getPlatforms: vi.fn(async () => ({ imessage: true })),
    enableImessage: vi.fn(async () => {}),
    listUsers: vi.fn(async () => ({ total: 0, users: [] })),
    createSharedUser: vi.fn(async (_id, input) => user('created-user', input.phoneNumber)),
    ...overrides,
  }
}

function project(id: string, extras: Partial<PhotonProject> = {}): PhotonProject {
  return { id, name: 'dsh', platforms: ['imessage'], projectSecret: `secret-${id}`, ...extras }
}

function user(id: string, phoneNumber = '+14155552671'): PhotonSpectrumUser {
  return {
    id,
    phoneNumber,
    assignedPhoneNumber: '+14155550000',
    type: 'shared',
  }
}

describe('Photon management idempotency', () => {
  it('reuses an accessible stored dsh project and enables iMessage when needed', async () => {
    const stored = project('stored', { platforms: [] })
    const api = management({
      getProject: vi.fn(async id => id === 'stored' ? stored : undefined),
      getPlatforms: vi.fn(async () => ({ imessage: false })),
    })
    await expect(ensureDshProject(api, 'stored')).resolves.toEqual({
      id: 'stored', name: 'dsh', secret: 'secret-stored',
    })
    expect(api.listProjects).not.toHaveBeenCalled()
    expect(api.createProject).not.toHaveBeenCalled()
    expect(api.enableImessage).toHaveBeenCalledWith('stored')
  })

  it('blocks multiple exact case-sensitive project matches with public ids', async () => {
    const api = management({
      listProjects: vi.fn(async () => [project('one'), project('two'), project('upper', { name: 'DSH' })]),
    })
    await expect(ensureDshProject(api)).rejects.toMatchObject({
      code: 'project-ambiguous', details: ['one', 'two'],
    })
    expect(api.createProject).not.toHaveBeenCalled()
  })

  it('falls back to the new account project list when the stored project is inaccessible', async () => {
    const exact = project('new-account-project')
    const api = management({
      getProject: vi.fn(async id => id === exact.id ? exact : undefined),
      listProjects: vi.fn(async () => [exact]),
    })
    await expect(ensureDshProject(api, 'old-account-project')).resolves.toEqual({
      id: exact.id,
      name: 'dsh',
      secret: exact.projectSecret,
    })
    expect(api.createProject).not.toHaveBeenCalled()
  })

  it('creates one dsh project only when no exact match exists', async () => {
    const created = project('created-project')
    const api = management({
      listProjects: vi.fn(async () => [project('other', { name: 'Dsh' })]),
      getProject: vi.fn(async id => id === created.id ? created : undefined),
    })
    await expect(ensureDshProject(api)).resolves.toEqual({
      id: created.id, name: 'dsh', secret: created.projectSecret,
    })
    expect(api.createProject).toHaveBeenCalledWith('dsh')
  })

  it('creates or reuses a custom Photon project name for per-machine isolation', async () => {
    const created = project('machine-b', { name: 'dsh-laptop-b' })
    const api = management({
      listProjects: vi.fn(async () => [project('default')]),
      getProject: vi.fn(async id => id === created.id ? created : undefined),
      createProject: vi.fn(async () => created.id),
    })
    await expect(ensureDshProject(api, undefined, 'dsh-laptop-b')).resolves.toEqual({
      id: created.id,
      name: 'dsh-laptop-b',
      secret: created.projectSecret,
    })
    expect(api.createProject).toHaveBeenCalledWith('dsh-laptop-b')
  })

  it('ignores a stored project when its name no longer matches the configured name', async () => {
    const stored = project('stored')
    const next = project('next', { name: 'dsh-desk' })
    const api = management({
      getProject: vi.fn(async id => {
        if (id === stored.id) return stored
        if (id === next.id) return next
        return undefined
      }),
      listProjects: vi.fn(async () => [stored, next]),
    })
    await expect(ensureDshProject(api, stored.id, 'dsh-desk')).resolves.toEqual({
      id: next.id,
      name: 'dsh-desk',
      secret: next.projectSecret,
    })
    expect(api.createProject).not.toHaveBeenCalled()
  })

  it('falls back to create when listing projects fails for a new project name', async () => {
    const created = project('created', { name: 'dsh-laptop-b' })
    const api = management({
      listProjects: vi.fn(async () => {
        throw new PluginError('photon-unavailable', 'Could not list Photon projects.')
      }),
      getProject: vi.fn(async id => id === created.id ? created : undefined),
      createProject: vi.fn(async () => created.id),
    })
    await expect(ensureDshProject(api, undefined, 'dsh-laptop-b')).resolves.toEqual({
      id: created.id,
      name: 'dsh-laptop-b',
      secret: created.projectSecret,
    })
    expect(api.createProject).toHaveBeenCalledWith('dsh-laptop-b')
  })

  it('reuses one exact phone user across paginated results', async () => {
    const exact = user('exact')
    const api = management({
      listUsers: vi.fn(async (_id, offset) => offset === 0
        ? { total: 2, users: [user('other', '+442071838750')] }
        : { total: 2, users: [exact] }),
    })
    await expect(ensureSharedUser(api, 'project', exact.phoneNumber, {
      id: 'account', email: 'user@example.com',
    })).resolves.toEqual(exact)
    expect(api.createSharedUser).not.toHaveBeenCalled()
  })

  it('blocks duplicate exact users and does not choose arbitrarily', async () => {
    const api = management({
      listUsers: vi.fn(async () => ({ total: 2, users: [user('one'), user('two')] })),
    })
    await expect(ensureSharedUser(api, 'project', '+14155552671', {
      id: 'account', email: 'user@example.com',
    })).rejects.toMatchObject({ code: 'user-ambiguous', details: ['one', 'two'] })
  })

  it('creates a shared user with names derived from identity and a stable fallback', async () => {
    const api = management()
    await ensureSharedUser(api, 'project', '+14155552671', {
      id: 'account', email: 'user@example.com', name: 'Ada Lovelace Byron',
    })
    expect(api.createSharedUser).toHaveBeenCalledWith('project', {
      firstName: 'Ada', lastName: 'Lovelace Byron', email: 'user@example.com', phoneNumber: '+14155552671',
    })
    expect(deriveNames()).toEqual({ firstName: 'DSH', lastName: 'User' })
  })

  it('maps a 200 account-level create rejection to manual resolution and sends shared/no-invite', async () => {
    let body: unknown
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ error: 'This phone already belongs to another user.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const api = createPhotonManagementApi('https://app.photon.codes', 'private-token', fetchImpl)
    await expect(api.createSharedUser('project', {
      firstName: 'DSH',
      lastName: 'User',
      email: 'user@example.com',
      phoneNumber: '+14155552671',
    })).rejects.toMatchObject({ code: 'user-resolution-required' })
    expect(body).toMatchObject({
      type: 'shared',
      sendInvite: false,
      phoneNumber: '+14155552671',
    })
  })
})

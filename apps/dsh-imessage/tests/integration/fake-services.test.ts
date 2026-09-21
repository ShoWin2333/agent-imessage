import { describe, expect, it, vi } from 'vitest'
import { authorizeDevice, type DeviceAuthApi } from '../../src/device-auth.js'
import { rememberInbound, type InboundDedupeTable } from '../../src/dedupe.js'
import {
  ensureDshProject,
  ensureSharedUser,
  type PhotonManagementApi,
} from '../../src/photon-management.js'
import {
  SpectrumSupervisor,
  type SpectrumConnection,
  type SpectrumInboundMessage,
} from '../../src/spectrum-runtime.js'

class AsyncMessages implements AsyncIterable<SpectrumInboundMessage> {
  private readonly values: SpectrumInboundMessage[] = []
  private readonly readers: Array<(value: IteratorResult<SpectrumInboundMessage>) => void> = []
  private ended = false

  push(value: SpectrumInboundMessage): void {
    const reader = this.readers.shift()
    if (reader === undefined) this.values.push(value)
    else reader({ done: false, value })
  }

  end(): void {
    this.ended = true
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined })
  }

  [Symbol.asyncIterator](): AsyncIterator<SpectrumInboundMessage> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value !== undefined) return { done: false, value }
        if (this.ended) return { done: true, value: undefined }
        return new Promise(resolve => { this.readers.push(resolve) })
      },
    }
  }
}

class MemoryDedupe implements InboundDedupeTable {
  readonly values = new Map<string, { receivedAt: number }>()
  get size() { return this.values.size }
  get(id: string) { return this.values.get(id) }
  async put(id: string, value: { receivedAt: number }) { this.values.set(id, value) }
  async delete(id: string) { this.values.delete(id) }
  keys() { return this.values.keys() }
  entries() { return this.values.entries() }
}

describe('fake Photon + Spectrum integration', () => {
  it('authorizes, creates dsh/user once, starts routing, and rejects replayed provider ids', async () => {
    const auth: DeviceAuthApi = {
      requestCode: async () => ({
        deviceCode: 'private-device-code',
        userCode: 'PUBLIC-CODE',
        verificationUri: 'https://app.photon.codes/device',
        intervalSeconds: 1,
        expiresInSeconds: 600,
      }),
      pollToken: async () => ({ kind: 'token', accessToken: 'private-management-token', expiresInSeconds: 3_600 }),
      getIdentity: async () => ({ id: 'account', email: 'user@example.com', name: 'Ada User' }),
    }
    const authorized = await authorizeDevice(auth, {
      signal: new AbortController().signal,
      sleep: async () => {},
      onCode: code => { expect(code).not.toHaveProperty('deviceCode') },
    })

    let createdProject = false
    const createUser = vi.fn(async (_projectId, input) => ({
      id: 'user',
      phoneNumber: input.phoneNumber,
      assignedPhoneNumber: '+14155550000',
      type: 'shared' as const,
    }))
    const management: PhotonManagementApi = {
      listProjects: async () => [],
      getProject: async id => createdProject && id === 'project'
        ? { id, name: 'dsh', platforms: ['imessage'], projectSecret: 'private-project-secret' }
        : undefined,
      createProject: async (_name) => { createdProject = true; return 'project' },
      getPlatforms: async () => ({ imessage: true }),
      enableImessage: async () => {},
      listUsers: async () => ({ total: 0, users: [] }),
      createSharedUser: createUser,
    }
    const project = await ensureDshProject(management)
    const user = await ensureSharedUser(management, project.id, '+14155552671', authorized.account)
    expect(createUser).toHaveBeenCalledOnce()

    const stream = new AsyncMessages()
    const stop = vi.fn(async () => { stream.end() })
    const factory = vi.fn(async (): Promise<SpectrumConnection> => ({ messages: stream, stop }))
    const dedupe = new MemoryDedupe()
    const routed: string[] = []
    const supervisor = new SpectrumSupervisor(factory, {
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      onState: () => {},
      onMessage: async message => {
        if (await rememberInbound(dedupe, message.id, 1_024)) routed.push(message.text)
      },
    })
    await supervisor.restart({
      projectId: project.id,
      projectSecret: project.secret,
      senderPhoneNumber: user.phoneNumber,
      assignedPhoneNumber: user.assignedPhoneNumber,
    })
    const message: SpectrumInboundMessage = {
      id: 'provider-message',
      text: 'hello dsh',
      responding: async callback => callback(),
      send: async () => {},
      sendFile: async () => {},
      sendVoice: async () => {},
    }
    stream.push(message)
    stream.push(message)
    await vi.waitFor(() => { expect(routed).toEqual(['hello dsh']) })
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project', assignedPhoneNumber: '+14155550000',
    }))
    await supervisor.stop()
    expect(stop).toHaveBeenCalledOnce()
  })
})

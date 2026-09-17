import { authorizeDevice, createPhotonDeviceAuthApi, type DeviceAuthorizationResult, type DeviceCodeView } from '../device-auth.js'
import { createPhotonManagementApi, ensurePhotonProject, ensureSharedUser } from '../photon-management.js'
import { atomicJson, readJson } from './config.js'
import { object } from '../backends/jsonrpc.js'
import { normalizePhotonProjectName } from '../workspace.js'
const origin = 'https://app.photon.codes'

/** App-owned OAuth and provisioning, sharing the single Photon API implementation. */
export class PhotonAccount {
  private credential: DeviceAuthorizationResult | undefined
  private controller: AbortController | undefined
  private code: DeviceCodeView | undefined
  private failed = false
  private generation = 0
  constructor(private readonly file: string) {}
  async load(): Promise<void> {
    try {
      const value = object(await readJson(this.file))
      if (typeof value.accessToken !== 'string' || typeof value.expiresAt !== 'number' || typeof object(value.account).id !== 'string' || typeof object(value.account).email !== 'string') throw new Error('Invalid Photon account')
      this.credential = value as unknown as DeviceAuthorizationResult
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  snapshot() {
    if (this.code) return { phase: 'pending', ...this.code }
    if (this.failed) return { phase: 'failed' }
    if (this.credential) return { phase: this.credential.expiresAt > Date.now() + 30_000 ? 'authorized' : 'reauthorization-required', account: this.credential.account }
    return { phase: 'disconnected' }
  }
  async begin(): Promise<void> {
    this.cancel(); this.failed = false
    const controller = new AbortController(), generation = this.generation
    this.controller = controller
    await new Promise<void>((resolve, reject) => {
      void authorizeDevice(createPhotonDeviceAuthApi(origin), {
        signal: controller.signal,
        onCode: code => { if (generation === this.generation) this.code = code; resolve() },
      }).then(async credential => {
        if (generation !== this.generation) return
        await atomicJson(this.file, credential)
        if (generation !== this.generation) return
        this.credential = credential; this.code = undefined; resolve()
      }).catch(() => { if (generation === this.generation) { this.code = undefined; this.failed = true }; reject(new Error('Photon authorization failed')) })
    })
  }
  cancel(): void { this.generation++; this.controller?.abort(); this.controller = undefined; this.code = undefined }
  async projects() {
    const credential = this.credential
    if (!credential || credential.expiresAt < Date.now() + 30_000) throw new Error('Authorize Photon first')
    const projects = await createPhotonManagementApi(origin, credential.accessToken).listProjects()
    return projects.map(({id, name}) => ({id, name}))
  }
  async select(projectId: string, sender: string) {
    const credential = this.credential
    if (!credential || credential.expiresAt < Date.now() + 30_000) throw new Error('Authorize Photon first')
    const api = createPhotonManagementApi(origin, credential.accessToken)
    const project = await api.getProject(projectId)
    if (!project?.projectSecret) throw new Error('Project unavailable or missing secret')
    if ((await api.getPlatforms(projectId)).imessage !== true) await api.enableImessage(projectId)
    const user = await ensureSharedUser(api, projectId, sender, credential.account)
    return { projectId, secret: project.projectSecret, assignedPhoneNumber: user.assignedPhoneNumber }
  }
  async provision(name: string, sender: string) {
    const credential = this.credential
    if (!credential || credential.expiresAt < Date.now() + 30_000) throw new Error('Authorize Photon first')
    const api = createPhotonManagementApi(origin, credential.accessToken)
    const project = await ensurePhotonProject(api, undefined, normalizePhotonProjectName(name))
    const user = await ensureSharedUser(api, project.id, sender, credential.account)
    return { projectId: project.id, secret: project.secret, assignedPhoneNumber: user.assignedPhoneNumber }
  }
}

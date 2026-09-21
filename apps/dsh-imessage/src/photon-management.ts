import { treaty } from '@elysiajs/eden'
import type { PublicApp } from '@photon-ai/dashboard-api'
import { DEFAULT_PHOTON_PROJECT_NAME } from './constants.js'
import { PluginError } from './errors.js'
import { normalizeE164 } from './phone.js'
import { createSecureFetch } from './secure-fetch.js'
import type { PhotonAccountView } from './types.js'

/** Minimal project representation needed by idempotent provisioning. */
export interface PhotonProject {
  /** Photon project id. */
  id: string
  /** Case-sensitive project name. */
  name: string
  /** Enabled Spectrum platforms when returned by list. */
  platforms: string[]
  /** Project secret when returned by Photon. */
  projectSecret?: string
}

/** Minimal Spectrum user representation needed by routing. */
export interface PhotonSpectrumUser {
  /** Photon Spectrum user id. */
  id: string
  /** Configured originating E.164 number. */
  phoneNumber: string
  /** Photon-hosted iMessage E.164 line. */
  assignedPhoneNumber: string
  /** Shared or dedicated allocation type. */
  type: 'shared' | 'dedicated'
}

/** Successful project provisioning result. */
export interface EnsuredProject {
  /** Photon project id. */
  id: string
  /** Configured Photon project name. */
  name: string
  /** Host-only Spectrum project secret. */
  secret: string
}

/** Injectable Photon management boundary. */
export interface PhotonManagementApi {
  /** List every project accessible to the account. */
  listProjects(): Promise<PhotonProject[]>
  /** Fetch one accessible project or undefined when missing. */
  getProject(id: string): Promise<PhotonProject | undefined>
  /** Create a US project with iMessage enabled under the given exact name. */
  createProject(name: string): Promise<string>
  /** Read platform enablement for one project. */
  getPlatforms(id: string): Promise<Record<string, boolean>>
  /** Enable iMessage for one project. */
  enableImessage(id: string): Promise<void>
  /** List one page of Spectrum users. */
  listUsers(id: string, offset: number, limit: number): Promise<{ total: number; users: PhotonSpectrumUser[] }>
  /** Create one shared Spectrum user without an invitation. */
  createSharedUser(id: string, input: SharedUserInput): Promise<PhotonSpectrumUser>
}

/** Input for shared Spectrum user creation. */
export interface SharedUserInput {
  /** Derived first name. */
  firstName: string
  /** Derived last name. */
  lastName: string
  /** Photon identity email. */
  email: string
  /** Strict E.164 originating number. */
  phoneNumber: string
}

/** Build the production Eden management adapter. */
export function createPhotonManagementApi(
  origin: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): PhotonManagementApi {
  const api = treaty<PublicApp>(origin, {
    headers: { Authorization: `Bearer ${accessToken}` },
    fetcher: createSecureFetch(origin, fetchImpl),
  })

  return {
    async listProjects() {
      const response = await api.api.projects.get()
      ensureResponse(response, 'list Photon projects')
      if (!Array.isArray(response.data)) throw unavailable('Photon returned an invalid project list.')
      return response.data.map(project => ({
        id: project.id,
        name: project.name,
        platforms: [...project.platforms],
        ...(project.projectSecret ? { projectSecret: project.projectSecret } : {}),
      }))
    },
    async getProject(id) {
      const response = await api.api.projects({ id }).get()
      // A stored project may belong to the previously authorized account.
      // Treat object-level forbidden/not-found as inaccessible and fall back to
      // the new account's exact-name list; listProjects still surfaces a truly
      // unauthorized management token.
      if (response.status === 403 || response.status === 404 || (!response.error && !response.data)) return undefined
      ensureResponse(response, 'read the Photon project')
      const project = response.data
      if (!project) return undefined
      return {
        id: project.id,
        name: project.name,
        platforms: [],
        ...(project.projectSecret ? { projectSecret: project.projectSecret } : {}),
      }
    },
    async createProject(name) {
      const response = await api.api.projects.post({
        name,
        location: 'United States',
        platforms: ['imessage'],
        template: false,
        observability: false,
      })
      ensureResponse(response, 'create the Photon project')
      if (!response.data || !('success' in response.data) || response.data.success !== true) {
        if (findFailureCode(response.data) === 'shared_line_unavailable') {
          throw new PluginError(
            'shared-line-unavailable',
            'Photon has no shared iMessage line available for this account. Contact Photon support or use a dedicated line.',
          )
        }
        throw unavailable('Photon did not create the configured project.')
      }
      return response.data.id
    },
    async getPlatforms(id) {
      const response = await api.api.projects({ id }).platforms.get()
      ensureResponse(response, 'read Photon project platforms')
      if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw unavailable('Photon returned invalid platform state.')
      }
      return response.data
    },
    async enableImessage(id) {
      const response = await api.api.projects({ id }).platforms.toggle.post({
        platformId: 'imessage',
        enabled: true,
      })
      ensureResponse(response, 'enable Photon iMessage')
      if (!response.data || !('success' in response.data) || response.data.success !== true) {
        throw unavailable('Photon could not enable iMessage for the dsh project.')
      }
    },
    async listUsers(id, offset, limit) {
      const response = await api.api.projects({ id }).spectrum.users.get({ query: { offset, limit } })
      ensureResponse(response, 'list Photon Spectrum users')
      if (!response.data || !Array.isArray(response.data.users)) {
        throw unavailable('Photon returned an invalid Spectrum user list.')
      }
      return {
        total: response.data.total,
        users: response.data.users.map(toSpectrumUser),
      }
    },
    async createSharedUser(id, input) {
      const response = await api.api.projects({ id }).spectrum.users.post({
        type: 'shared',
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phoneNumber: input.phoneNumber,
        sendInvite: false,
      })
      if (response.error) throwSpectrumCreateFailure(response.error, response.status)
      const data = response.data
      if (!data || !('success' in data) || data.success !== true) {
        const failure = data && 'error' in data && typeof data.error === 'string'
          ? { code: 'shared_user_create_failed', message: data.error }
          : data
        throwSpectrumCreateFailure(failure, response.status)
      }
      return toSpectrumUser(data.user)
    },
  }
}

/** Idempotently select/create the configured Photon project and ensure iMessage. */
export async function ensureDshProject(
  api: PhotonManagementApi,
  storedProjectId?: string,
  projectName: string = DEFAULT_PHOTON_PROJECT_NAME,
): Promise<EnsuredProject> {
  let project: PhotonProject | undefined
  if (storedProjectId !== undefined) {
    const stored = await api.getProject(storedProjectId)
    if (stored?.name === projectName) project = stored
  }

  let listError: unknown
  if (project === undefined) {
    try {
      const exact = (await api.listProjects()).filter(candidate => candidate.name === projectName)
      if (exact.length > 1) {
        throw new PluginError(
          'project-ambiguous',
          `Multiple Photon projects are named exactly ${projectName}. Rename extras before continuing.`,
          exact.map(candidate => candidate.id),
        )
      }
      project = exact[0]
    } catch (error) {
      if (error instanceof PluginError && error.code === 'project-ambiguous') throw error
      listError = error
    }
  }

  if (project === undefined) {
    try {
      const id = await api.createProject(projectName)
      project = await api.getProject(id)
      if (project === undefined || project.name !== projectName) {
        throw unavailable('Photon created a project but it could not be read back.')
      }
    } catch (error) {
      if (listError !== undefined) throw listError
      throw error
    }
  }

  const platforms = await api.getPlatforms(project.id)
  if (platforms['imessage'] !== true) await api.enableImessage(project.id)

  const detail = await api.getProject(project.id)
  if (!detail?.projectSecret) {
    throw unavailable('The Photon project has no Spectrum secret. Generate one in Photon, then reauthorize.')
  }
  return { id: detail.id, name: projectName, secret: detail.projectSecret }
}

/** Reuse one exact phone match or create one shared Spectrum user. */
export async function ensureSharedUser(
  api: PhotonManagementApi,
  projectId: string,
  phoneNumber: string,
  identity: PhotonAccountView,
): Promise<PhotonSpectrumUser> {
  const normalized = normalizeE164(phoneNumber)
  const users: PhotonSpectrumUser[] = []
  const limit = 100
  let offset = 0
  for (;;) {
    const page = await api.listUsers(projectId, offset, limit)
    users.push(...page.users)
    offset += page.users.length
    if (offset >= page.total || page.users.length === 0) break
  }

  const matches = users.filter(user => user.phoneNumber === normalized)
  if (matches.length > 1) {
    throw new PluginError(
      'user-ambiguous',
      'Multiple Photon users have this sending number. Resolve the duplicates in Photon before continuing.',
      matches.map(user => user.id),
    )
  }
  if (matches[0] !== undefined) return validateAssignedLine(matches[0])

  const names = deriveNames(identity.name)
  const created = await api.createSharedUser(projectId, {
    ...names,
    email: identity.email,
    phoneNumber: normalized,
  })
  return validateAssignedLine(created)
}

/** Derive required Spectrum names from Photon identity with a stable fallback. */
export function deriveNames(displayName?: string): { firstName: string; lastName: string } {
  const parts = displayName?.trim().split(/\s+/u).filter(Boolean) ?? []
  if (parts.length === 0) return { firstName: 'DSH', lastName: 'User' }
  if (parts.length === 1) return { firstName: parts[0] ?? 'DSH', lastName: 'User' }
  return {
    firstName: parts[0] ?? 'DSH',
    lastName: parts.slice(1).join(' ') || 'User',
  }
}

function validateAssignedLine(user: PhotonSpectrumUser): PhotonSpectrumUser {
  try {
    return { ...user, assignedPhoneNumber: normalizeE164(user.assignedPhoneNumber) }
  } catch {
    throw unavailable('Photon did not return a valid hosted iMessage number for this user.')
  }
}

function toSpectrumUser(user: {
  id: string
  phoneNumber: string
  assignedPhoneNumber: string
  type: 'shared' | 'dedicated'
}): PhotonSpectrumUser {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    assignedPhoneNumber: user.assignedPhoneNumber,
    type: user.type,
  }
}

function ensureResponse(
  response: { error: unknown; status: number },
  operation: string,
): void {
  if (!response.error) return
  if (response.status === 401 || response.status === 403) {
    throw new PluginError('authorization-required', 'Photon authorization expired. Reauthorize to change configuration.')
  }
  // Eden maps thrown fetch failures (network, rejected redirects) to status 503.
  if (response.status === 503) {
    throw unavailable(
      `Could not ${operation} because Photon was unreachable. Check network access to the Photon API and retry.`,
    )
  }
  const detail = safeErrorDetail(response.error)
  throw unavailable(detail === undefined
    ? `Could not ${operation}.`
    : `Could not ${operation} (HTTP ${response.status}: ${detail}).`)
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  for (const key of ['value', 'message']) {
    const nested = record[key]
    if (typeof nested === 'string') {
      const trimmed = nested.trim()
      if (trimmed.length === 0) continue
      if (/token|secret|bearer|authorization/i.test(trimmed)) return undefined
      return trimmed.slice(0, 120)
    }
    if (nested instanceof Error) {
      const message = nested.message.trim()
      if (message.length === 0 || /token|secret|bearer|authorization/i.test(message)) return undefined
      return message.slice(0, 120)
    }
  }
  return undefined
}

function throwSpectrumCreateFailure(error: unknown, status: number): never {
  if (status === 401 || status === 403) {
    throw new PluginError('authorization-required', 'Photon authorization expired. Reauthorize to change configuration.')
  }
  const code = findFailureCode(error)
  if (code === 'shared_line_unavailable') {
    throw new PluginError(
      'shared-line-unavailable',
      'Photon has no shared iMessage line available. Contact Photon support or configure a dedicated line.',
    )
  }
  if (code === 'imessage_not_enabled') {
    throw unavailable('Photon reports that iMessage is not enabled for the dsh project.')
  }
  if (status === 409 || code === 'shared_user_create_failed') {
    throw new PluginError(
      'user-resolution-required',
      'Photon could not create this shared user, usually because the number exists elsewhere in the account. Resolve it in Photon and retry.',
    )
  }
  throw unavailable('Photon could not create the shared iMessage user.')
}

function findFailureCode(value: unknown): string | undefined {
  const queue: unknown[] = [value]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const record = current as Record<string, unknown>
    if (typeof record['code'] === 'string') return record['code']
    for (const key of ['value', 'message', 'error', 'cause']) {
      const nested = record[key]
      if (nested && typeof nested === 'object') queue.push(nested)
    }
  }
  return undefined
}

function unavailable(message: string): PluginError {
  return new PluginError('photon-unavailable', message)
}

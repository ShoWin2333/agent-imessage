import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  SettingsConflictError,
  type SettingsDescriptor,
  type SettingsNamespace,
  type SettingsScope,
} from '@deepseek-ai/dsh-settings'
import {
  type Domain,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  Config as ConfigSchema,
  PluginSettingsSchema,
  resolveConfig,
  type Config,
  type PluginSettings,
  type ResolvedConfig,
  type RouteSettings,
} from './config.js'
import {
  findProjectCredential,
  parsePhotonCredential,
  serializePhotonCredential,
  upsertProjectCredential,
  type PhotonCredential,
} from './credential.js'
import { CREDENTIAL_NAME, SETTINGS_NAME } from './constants.js'
import { rememberInbound } from './dedupe.js'
import {
  authorizeDevice,
  createPhotonDeviceAuthApi,
  type DeviceCodeView,
} from './device-auth.js'
import { PluginError, publicError } from './errors.js'
import {
  createPhotonManagementApi,
  ensureDshProject,
  ensureSharedUser,
} from './photon-management.js'
import { normalizeE164 } from './phone.js'
import { RouteManager } from './route-manager.js'
import {
  createRouteSettings,
  normalizeRoutes,
  removeRouteFromList,
  routeDisplayLabel,
  settingsFromRoutes,
  upsertRouteList,
} from './routes.js'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'
import { pluginDomainSpec, readActiveSession, writeActiveSessions } from './storage.js'
import type {
  AuthorizationView,
  DisconnectRequest,
  ImessagePluginState,
  MutationResult,
  PhotonAccountView,
  ProvisioningView,
  RemoveRouteRequest,
  RetryRouteRuntimeRequest,
  SavePhoneRequest,
  SaveRoutePhoneRequest,
  SaveWorkspaceRequest,
  UpsertRouteRequest,
} from './types.js'
import { isAbsolutePathShape, unwrapCopiedPath } from './path-shape.js'
import { normalizePhotonProjectName, resolveWorkspaceCwd } from './workspace.js'

export type * from './types.js'
export { normalizeE164 } from './phone.js'
export { chunkText } from './chunks.js'
export { rememberInbound } from './dedupe.js'
export { acceptsInboundMessage } from './spectrum-runtime.js'
export { parseCommand } from './commands.js'
export { presetForResume, selectionForResume } from './session-selection.js'
export { parseQuestionAnswer } from './question-answer.js'
export { TurnCorrelation } from './turn-correlation.js'
export { authorizeDevice } from './device-auth.js'
export { ensureDshProject, ensureSharedUser } from './photon-management.js'
export { isAbsolutePathShape, unwrapCopiedPath } from './path-shape.js'
export { normalizePhotonProjectName, resolveWorkspaceCwd } from './workspace.js'
export { normalizeRoutes, createRouteSettings } from './routes.js'

/** Cordis plugin name. */
export const name = 'dsh-imessage'

/** Required DSH host services. */
export const inject = [
  'settings',
  'credentials',
  'storageDomain',
  'agents',
  'sessions',
  'sessionPersistence',
  'agentPresets',
  'agentDefaultModel',
  'tools',
  'approval',
  'userQuestions',
]

/** DSH non-secret settings namespace. */
export const SETTINGS_NAMESPACE = SETTINGS_NAME as SettingsNamespace

/** Opaque Photon credential reference. */
export const PHOTON_CREDENTIAL_REF = credentialRef(CREDENTIAL_NAME)

type PluginDomain = Domain<typeof pluginDomainSpec>
type InboundTable = KvTable<string, { receivedAt: number }>

/** Host service implementing Photon provisioning, Spectrum, DSH routing, and typed RPC. */
export class DshPhotonImessageService extends TypertRemoteService {
  static inject = inject
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private settingsScope?: SettingsScope<PluginSettings>
  private domain?: PluginDomain
  private inbound?: InboundTable
  private routes?: RouteManager
  private authorizationOverride: AuthorizationView | undefined
  private provisioning: ProvisioningView = { phase: 'idle' }
  private authController: AbortController | undefined
  private authTask: Promise<void> | undefined
  private authGeneration = 0
  private provisionTail = Promise.resolve()

  /** Construct the host service; async resources open in Service.init. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'dshPhotonImessage')
    this.config = resolveConfig(config)
  }

  /** Register settings, open durable state, and resume local routing. */
  protected async [Service.init](): Promise<void> {
    this.settingsScope = this.ctx.settings.register(SETTINGS_NAMESPACE, PluginSettingsSchema, {
      applies: 'live',
      validate: validateSettings,
    })
    const domain = await this.ctx.storageDomain.open(pluginDomainSpec)
    this.domain = domain
    this.inbound = domain.table('inbound')

    const routes = new RouteManager(
      this.ctx,
      this.config,
      routeId => ({
        get: () => readActiveSession(domain.global.get(), routeId),
        set: async sessionId => {
          const current = domain.global.get()
          await domain.global.set(writeActiveSessions(current, routeId, sessionId))
        },
      }),
      async (routeId, message) => {
        const table = this.requireInboundTable()
        if (!await rememberInbound(table, message.id, this.config.dedupeEntries)) return
        await this.requireRoutes().require(routeId).router.receive(message)
      },
    )
    this.routes = routes

    const settingsRoutes = normalizeRoutes(this.settingsScope.get())
    for (const route of settingsRoutes) await routes.ensureBinding(route)

    const credential = await this.resolveCredential()
    if (credential !== undefined) {
      const primary = credential.projects[0]
      this.provisioning = primary === undefined
        ? { phase: 'idle' }
        : { phase: 'ready', project: { id: primary.id, name: primary.name } }
      for (const route of settingsRoutes) {
        const project = findProjectCredential(credential, route.photonProjectName)
        if (project === undefined || route.phoneNumber === undefined || route.assignedPhoneNumber === undefined) {
          continue
        }
        void routes.startRoute(route, {
          projectId: project.id,
          projectSecret: project.secret,
          senderPhoneNumber: route.phoneNumber,
          assignedPhoneNumber: route.assignedPhoneNumber,
        })
      }
    }

    this.ctx.effect(() => async () => {
      this.authGeneration += 1
      this.authController?.abort(new DOMException('Plugin stopped', 'AbortError'))
      await routes.close()
      await domain.close()
    }, 'dsh-imessage.teardown')
  }

  /** Read the complete redacted settings-page state. */
  @Remote('getState')
  async getState(): Promise<ImessagePluginState> {
    const descriptor = this.settingsDescriptor()
    const credentialInfo = await this.ctx.credentials.describe(PHOTON_CREDENTIAL_REF)
    const credential = await this.resolveCredential(false)
    const settingsRoutes = normalizeRoutes(this.requireSettings().get())
    return {
      revision: descriptor.revision,
      settingsWritable: this.ctx.settings.writable,
      credentialConfigured: credentialInfo.configured,
      credentialWritable: credentialInfo.writable,
      authorization: this.authorizationView(credential),
      provisioning: this.provisioning,
      routes: await this.requireRoutes().project(settingsRoutes),
    }
  }

  /** Persist one route's local workspace and Photon project name. */
  @Remote('upsertRoute')
  async upsertRoute(request: UpsertRouteRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      const workspaceCwd = await resolveWorkspaceCwd(request.workspaceCwd)
      const photonProjectName = normalizePhotonProjectName(request.photonProjectName)
      const currentRoutes = normalizeRoutes(this.requireSettings().get())
      const existing = request.id === undefined
        ? undefined
        : currentRoutes.find(route => route.id === request.id)
      if (request.id !== undefined && existing === undefined) {
        throw new PluginError('invalid-command', 'That iMessage route no longer exists. Refresh and try again.')
      }

      const duplicateProject = currentRoutes.find(route => (
        route.photonProjectName === photonProjectName && route.id !== request.id
      ))
      if (duplicateProject !== undefined) {
        throw new PluginError(
          'invalid-project-name',
          `Photon project "${photonProjectName}" is already used by route "${routeDisplayLabel(duplicateProject)}".`,
        )
      }

      const nextRoute = createRouteSettings({
        ...(existing?.id !== undefined ? { id: existing.id } : {}),
        ...(request.label !== undefined
          ? { label: request.label }
          : existing?.label !== undefined ? { label: existing.label } : {}),
        workspaceCwd,
        photonProjectName,
        ...(existing?.phoneNumber !== undefined ? { phoneNumber: existing.phoneNumber } : {}),
        ...(existing?.assignedPhoneNumber !== undefined
          ? { assignedPhoneNumber: existing.assignedPhoneNumber }
          : {}),
        ...(existing?.photonUserId !== undefined ? { photonUserId: existing.photonUserId } : {}),
      })
      const projectChanged = existing !== undefined
        && existing.photonProjectName !== nextRoute.photonProjectName
      const nextRoutes = upsertRouteList(currentRoutes, nextRoute)

      await this.ctx.settings.replace(
        SETTINGS_NAMESPACE,
        settingsFromRoutes(nextRoutes),
        request.expectedRevision,
      )
      await this.requireRoutes().ensureBinding(nextRoute)

      const managementCredential = projectChanged || existing === undefined
        ? await this.resolveCredential()
        : undefined
      const canProvision = managementCredential !== undefined
        && managementCredential.accessTokenExpiresAt > Date.now()
      if (!canProvision) return

      this.provisioning = { phase: 'project' }
      const api = createPhotonManagementApi(
        managementCredential.apiOrigin,
        managementCredential.accessToken,
      )
      try {
        const project = await ensureDshProject(
          api,
          findProjectCredential(managementCredential, photonProjectName)?.id,
          photonProjectName,
        )
        let phoneFields: Pick<RouteSettings, 'phoneNumber' | 'assignedPhoneNumber' | 'photonUserId'> = {}
        if (nextRoute.phoneNumber !== undefined) {
          this.provisioning = { phase: 'user' }
          const user = await ensureSharedUser(
            api,
            project.id,
            nextRoute.phoneNumber,
            accountView(managementCredential.account),
          )
          phoneFields = {
            phoneNumber: nextRoute.phoneNumber,
            assignedPhoneNumber: user.assignedPhoneNumber,
            photonUserId: user.id,
          }
        }

        const nextCredential = upsertProjectCredential(managementCredential, {
          id: project.id,
          name: project.name,
          secret: project.secret,
        })
        const provisionedRoute = createRouteSettings({ ...nextRoute, ...phoneFields })
        const connectionConfig = provisionedRoute.phoneNumber === undefined
          || provisionedRoute.assignedPhoneNumber === undefined
          ? undefined
          : {
            projectId: project.id,
            projectSecret: project.secret,
            senderPhoneNumber: provisionedRoute.phoneNumber,
            assignedPhoneNumber: provisionedRoute.assignedPhoneNumber,
          }
        const prepared = connectionConfig === undefined
          ? undefined
          : (await this.requireRoutes().prepareRoute(provisionedRoute, connectionConfig)).prepared

        const oldCredentialValue = (await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF))?.value
        const switchRevision = this.settingsDescriptor().revision
        try {
          await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, serializePhotonCredential(nextCredential))
          await this.ctx.settings.replace(
            SETTINGS_NAMESPACE,
            settingsFromRoutes(upsertRouteList(nextRoutes, provisionedRoute)),
            switchRevision,
          )
        } catch (error) {
          if (prepared !== undefined) await prepared.stop().catch(() => {})
          if (oldCredentialValue === undefined) await this.ctx.credentials.unset(PHOTON_CREDENTIAL_REF)
          else await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, oldCredentialValue)
          throw error
        }

        this.provisioning = {
          phase: 'ready',
          project: { id: project.id, name: project.name },
        }
        if (connectionConfig !== undefined && prepared !== undefined) {
          await this.requireRoutes().activateRoute(provisionedRoute.id, connectionConfig, prepared)
        }
      } catch (error) {
        const safe = publicError(error)
        this.provisioning = { phase: 'failed', error: safe }
        throw error
      }
    }))
  }

  /** Remove one local route without deleting Photon cloud resources. */
  @Remote('removeRoute')
  async removeRoute(request: RemoveRouteRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      const currentRoutes = normalizeRoutes(this.requireSettings().get())
      if (currentRoutes.length <= 1) {
        throw new PluginError('invalid-command', 'Keep at least one iMessage route, or use Disconnect.')
      }
      if (!currentRoutes.some(route => route.id === request.routeId)) {
        throw new PluginError('invalid-command', 'That iMessage route no longer exists. Refresh and try again.')
      }
      const nextRoutes = removeRouteFromList(currentRoutes, request.routeId)
      await this.ctx.settings.replace(
        SETTINGS_NAMESPACE,
        settingsFromRoutes(nextRoutes),
        request.expectedRevision,
      )
      await this.requireRoutes().disposeRoute(request.routeId)
      const domain = this.requireDomain()
      await domain.global.set(writeActiveSessions(domain.global.get(), request.routeId, undefined))
    }))
  }

  /** @deprecated Prefer upsertRoute; updates the first/default route. */
  @Remote('saveWorkspace')
  async saveWorkspace(request: SaveWorkspaceRequest): Promise<MutationResult> {
    const primary = normalizeRoutes(this.requireSettings().get())[0]
    return this.upsertRoute({
      ...(primary?.id !== undefined ? { id: primary.id } : {}),
      workspaceCwd: request.workspaceCwd,
      photonProjectName: request.photonProjectName,
      expectedRevision: request.expectedRevision,
    })
  }

  /** Start Photon CLI-compatible device authorization and return once its code is available. */
  @Remote('beginAuthorization')
  async beginAuthorization(): Promise<MutationResult> {
    return this.mutation(async () => {
      await this.requireWritablePlanes()
      if (this.authTask !== undefined && this.authController === undefined) {
        throw new PluginError('busy', 'Photon authorization is already provisioning the project.')
      }
      this.cancelAuthorizationInternal()
      const generation = ++this.authGeneration
      const controller = new AbortController()
      this.authController = controller
      const expectedRevision = this.settingsDescriptor().revision
      const oldCredentialValue = (await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF))?.value

      let codeResolve!: () => void
      let codeReject!: (error: unknown) => void
      const codeReady = new Promise<void>((resolve, reject) => {
        codeResolve = resolve
        codeReject = reject
      })
      let codePublished = false
      const flow = authorizeDevice(createPhotonDeviceAuthApi(this.config.photonApiOrigin), {
        signal: controller.signal,
        onCode: (code: DeviceCodeView) => {
          if (generation !== this.authGeneration) return
          codePublished = true
          this.authorizationOverride = {
            phase: 'pending',
            userCode: code.userCode,
            verificationUri: code.verificationUri,
            ...(code.verificationUriComplete === undefined
              ? {}
              : { verificationUriComplete: code.verificationUriComplete }),
            expiresAt: code.expiresAt,
          }
          codeResolve()
        },
      })

      const task = flow.then(async result => {
        if (generation !== this.authGeneration || controller.signal.aborted) return
        this.authController = undefined
        this.authorizationOverride = {
          phase: 'authorized',
          account: result.account,
          expiresAt: result.expiresAt,
        }
        await this.enqueueProvision(() => this.completeAuthorization(
          result,
          expectedRevision,
          oldCredentialValue,
          generation,
          controller.signal,
        ))
      }).catch(error => {
        if (!codePublished) codeReject(error)
        if (generation !== this.authGeneration || isAbortError(error)) return
        const safe = publicError(error)
        this.authorizationOverride = { phase: 'failed', error: safe }
        this.provisioning = { phase: 'failed', error: safe }
      })
      this.authTask = task
      void task.then(() => {
        if (this.authTask === task) this.authTask = undefined
      })
      await codeReady
    })
  }

  /** Cancel an in-progress device authorization without changing the working config. */
  @Remote('cancelAuthorization')
  async cancelAuthorization(): Promise<MutationResult> {
    return this.mutation(async () => {
      this.cancelAuthorizationInternal()
    })
  }

  /** Provision or reuse the sending number for one route. */
  @Remote('saveRoutePhone')
  async saveRoutePhone(request: SaveRoutePhoneRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      const phoneNumber = normalizeE164(request.phoneNumber)
      const currentRoutes = normalizeRoutes(this.requireSettings().get())
      const route = currentRoutes.find(candidate => candidate.id === request.routeId)
      if (route === undefined) {
        throw new PluginError('invalid-command', 'That iMessage route no longer exists. Refresh and try again.')
      }
      const credential = await this.requireManagementCredential()
      this.provisioning = { phase: 'project' }
      const api = createPhotonManagementApi(credential.apiOrigin, credential.accessToken)
      const project = await ensureDshProject(
        api,
        findProjectCredential(credential, route.photonProjectName)?.id,
        route.photonProjectName,
      )
      this.provisioning = { phase: 'user' }
      let prepared: Awaited<ReturnType<RouteManager['prepareRoute']>>['prepared'] | undefined
      try {
        const user = await ensureSharedUser(
          api,
          project.id,
          phoneNumber,
          accountView(credential.account),
        )
        const connectionConfig = {
          projectId: project.id,
          projectSecret: project.secret,
          senderPhoneNumber: phoneNumber,
          assignedPhoneNumber: user.assignedPhoneNumber,
        }
        const provisionedRoute = createRouteSettings({
          ...route,
          phoneNumber,
          assignedPhoneNumber: user.assignedPhoneNumber,
          photonUserId: user.id,
        })
        prepared = (await this.requireRoutes().prepareRoute(provisionedRoute, connectionConfig)).prepared
        const nextCredential = upsertProjectCredential(credential, {
          id: project.id,
          name: project.name,
          secret: project.secret,
        })
        await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, serializePhotonCredential(nextCredential))
        await this.ctx.settings.replace(
          SETTINGS_NAMESPACE,
          settingsFromRoutes(upsertRouteList(currentRoutes, provisionedRoute)),
          request.expectedRevision,
        )
        this.provisioning = {
          phase: 'ready',
          project: { id: project.id, name: project.name },
        }
        await this.requireRoutes().activateRoute(provisionedRoute.id, connectionConfig, prepared)
        prepared = undefined
      } catch (error) {
        if (prepared !== undefined) await prepared.stop().catch(() => {})
        const safe = publicError(error)
        this.provisioning = { phase: 'failed', error: safe }
        throw error
      }
    }))
  }

  /** @deprecated Prefer saveRoutePhone; updates the first/default route. */
  @Remote('savePhone')
  async savePhone(request: SavePhoneRequest): Promise<MutationResult> {
    const primary = normalizeRoutes(this.requireSettings().get())[0]
    if (primary === undefined) {
      return this.mutation(async () => {
        throw new PluginError('invalid-command', 'Create an iMessage route before saving a phone number.')
      })
    }
    return this.saveRoutePhone({
      routeId: primary.id,
      phoneNumber: request.phoneNumber,
      expectedRevision: request.expectedRevision,
    })
  }

  /** Clear local routing/config/credentials while preserving Photon cloud resources. */
  @Remote('disconnect')
  async disconnect(request: DisconnectRequest): Promise<MutationResult> {
    return this.mutation(() => this.enqueueProvision(async () => {
      await this.requireWritablePlanes()
      this.assertRevision(request.expectedRevision)
      this.cancelAuthorizationInternal()
      const oldCredential = (await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF))?.value
      await this.ctx.credentials.unset(PHOTON_CREDENTIAL_REF)
      try {
        await this.ctx.settings.replace(SETTINGS_NAMESPACE, {}, request.expectedRevision)
      } catch (error) {
        if (oldCredential !== undefined) await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, oldCredential)
        throw error
      }

      await this.requireRoutes().resetAll()
      const table = this.requireInboundTable()
      for (const key of [...table.keys()]) await table.delete(key)
      await this.requireDomain().global.set({})
      this.authorizationOverride = undefined
      this.provisioning = { phase: 'idle' }
    }))
  }

  /** Retry Spectrum for one route. */
  @Remote('retryRouteRuntime')
  async retryRouteRuntime(request: RetryRouteRuntimeRequest): Promise<MutationResult> {
    return this.mutation(async () => {
      const credential = await this.resolveCredential()
      const route = normalizeRoutes(this.requireSettings().get())
        .find(candidate => candidate.id === request.routeId)
      if (credential === undefined || route === undefined
        || route.phoneNumber === undefined || route.assignedPhoneNumber === undefined) {
        throw new PluginError('runtime-failed', 'Authorize Photon and save a phone number before retrying iMessage.')
      }
      const project = findProjectCredential(credential, route.photonProjectName)
      if (project === undefined) {
        throw new PluginError('runtime-failed', 'Save the route workspace again to provision its Photon project.')
      }
      await this.requireRoutes().startRoute(route, {
        projectId: project.id,
        projectSecret: project.secret,
        senderPhoneNumber: route.phoneNumber,
        assignedPhoneNumber: route.assignedPhoneNumber,
      })
    })
  }

  /** @deprecated Prefer retryRouteRuntime; retries the first/default route. */
  @Remote('retryRuntime')
  async retryRuntime(): Promise<MutationResult> {
    const primary = normalizeRoutes(this.requireSettings().get())[0]
    if (primary === undefined) {
      return this.mutation(async () => {
        throw new PluginError('runtime-failed', 'Create an iMessage route before retrying the listener.')
      })
    }
    return this.retryRouteRuntime({ routeId: primary.id })
  }

  private async completeAuthorization(
    result: Awaited<ReturnType<typeof authorizeDevice>>,
    expectedRevision: number,
    oldCredentialValue: string | undefined,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    assertAuthorizationActive(generation, this.authGeneration, signal)
    this.provisioning = { phase: 'project' }
    const management = createPhotonManagementApi(this.config.photonApiOrigin, result.accessToken)
    const oldCredential = await this.resolveCredential(false)
    const currentRoutes = normalizeRoutes(this.requireSettings().get())
    const projects = []
    const nextRoutes: RouteSettings[] = []

    for (const route of currentRoutes) {
      assertAuthorizationActive(generation, this.authGeneration, signal)
      const project = await ensureDshProject(
        management,
        findProjectCredential(
          oldCredential ?? {
            version: 2,
            apiOrigin: this.config.photonApiOrigin,
            accessToken: result.accessToken,
            accessTokenExpiresAt: result.expiresAt,
            account: result.account,
            projects: [],
          },
          route.photonProjectName,
        )?.id,
        route.photonProjectName,
      )
      projects.push({ id: project.id, name: project.name, secret: project.secret })

      if (route.phoneNumber === undefined) {
        nextRoutes.push(route)
        continue
      }
      this.provisioning = { phase: 'user' }
      const user = await ensureSharedUser(
        management,
        project.id,
        route.phoneNumber,
        result.account,
      )
      nextRoutes.push(createRouteSettings({
        ...route,
        phoneNumber: route.phoneNumber,
        assignedPhoneNumber: user.assignedPhoneNumber,
        photonUserId: user.id,
      }))
    }
    assertAuthorizationActive(generation, this.authGeneration, signal)

    if (projects.length === 0) {
      const fallback = await ensureDshProject(management, oldCredential?.projects[0]?.id, 'dsh')
      projects.push({ id: fallback.id, name: fallback.name, secret: fallback.secret })
    }

    const credential: PhotonCredential = {
      version: 2,
      apiOrigin: this.config.photonApiOrigin,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.expiresAt,
      account: result.account,
      projects,
    }

    try {
      await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, serializePhotonCredential(credential))
      await this.ctx.settings.replace(
        SETTINGS_NAMESPACE,
        settingsFromRoutes(nextRoutes.length > 0 ? nextRoutes : currentRoutes),
        expectedRevision,
      )
    } catch (error) {
      if (oldCredentialValue === undefined) await this.ctx.credentials.unset(PHOTON_CREDENTIAL_REF)
      else await this.ctx.credentials.set(PHOTON_CREDENTIAL_REF, oldCredentialValue)
      throw error
    }
    assertAuthorizationActive(generation, this.authGeneration, signal)

    this.authorizationOverride = undefined
    this.provisioning = {
      phase: 'ready',
      project: { id: projects[0]!.id, name: projects[0]!.name },
    }

    for (const route of nextRoutes) {
      const project = projects.find(candidate => candidate.name === route.photonProjectName)
      if (project === undefined || route.phoneNumber === undefined || route.assignedPhoneNumber === undefined) {
        continue
      }
      await this.requireRoutes().startRoute(route, {
        projectId: project.id,
        projectSecret: project.secret,
        senderPhoneNumber: route.phoneNumber,
        assignedPhoneNumber: route.assignedPhoneNumber,
      })
    }
  }

  private authorizationView(credential: PhotonCredential | undefined): AuthorizationView {
    if (this.authorizationOverride !== undefined) return this.authorizationOverride
    if (credential === undefined) return { phase: 'disconnected' }
    if (credential.accessTokenExpiresAt <= Date.now()) {
      return { phase: 'reauthorization-required', account: accountView(credential.account) }
    }
    return {
      phase: 'authorized',
      account: accountView(credential.account),
      expiresAt: credential.accessTokenExpiresAt,
    }
  }

  private async requireManagementCredential(): Promise<PhotonCredential> {
    const credential = await this.resolveCredential()
    if (credential === undefined || credential.accessTokenExpiresAt <= Date.now()) {
      throw new PluginError(
        'authorization-required',
        'Photon management authorization expired. Reauthorize; existing iMessage routing can continue.',
      )
    }
    return credential
  }

  private async resolveCredential(reportFailure = true): Promise<PhotonCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(PHOTON_CREDENTIAL_REF)
    if (resolved === undefined) return undefined
    try {
      const credential = parsePhotonCredential(resolved.value)
      if (credential.apiOrigin !== this.config.photonApiOrigin) {
        throw new Error('credential origin mismatch')
      }
      return credential
    } catch {
      if (reportFailure) {
        const error = publicError(new PluginError(
          'authorization-required',
          'The stored Photon credential is invalid for this API origin. Disconnect or reauthorize.',
        ))
        this.provisioning = { phase: 'failed', error }
      }
      return undefined
    }
  }

  private async requireWritablePlanes(): Promise<void> {
    if (!this.ctx.settings.writable) {
      throw new PluginError('settings-readonly', 'The active DSH settings provider is read-only.')
    }
    const info = await this.ctx.credentials.describe(PHOTON_CREDENTIAL_REF)
    if (!info.writable) {
      throw new PluginError(
        'credential-readonly',
        'The Photon credential is supplied by a read-only source. Remove that override before changing iMessage setup.',
      )
    }
  }

  private cancelAuthorizationInternal(): void {
    const controller = this.authController
    if (controller !== undefined) {
      this.authGeneration += 1
      controller.abort(new DOMException('Authorization cancelled', 'AbortError'))
      this.authController = undefined
    }
    if (this.authorizationOverride?.phase === 'pending' || this.authorizationOverride?.phase === 'failed') {
      this.authorizationOverride = undefined
    }
  }

  private assertRevision(expected: number): void {
    const actual = this.settingsDescriptor().revision
    if (actual !== expected) throw new SettingsConflictError(SETTINGS_NAMESPACE, expected, actual)
  }

  private enqueueProvision<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.provisionTail.then(operation, operation)
    this.provisionTail = result.then(() => {}, () => {})
    return result
  }

  private async mutation(operation: () => Promise<void> | void): Promise<MutationResult> {
    try {
      await operation()
      return { ok: true, state: await this.getState() }
    } catch (error) {
      return { ok: false, error: publicError(error), state: await this.getState() }
    }
  }

  private settingsDescriptor(): SettingsDescriptor {
    const descriptor = this.ctx.settings.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === SETTINGS_NAMESPACE)
    if (descriptor === undefined) throw new Error('dsh-imessage settings are not registered')
    return descriptor
  }

  private requireSettings(): SettingsScope<PluginSettings> {
    if (this.settingsScope === undefined) throw new Error('dsh-imessage settings are not initialized')
    return this.settingsScope
  }

  private requireDomain(): PluginDomain {
    if (this.domain === undefined) throw new Error('dsh-imessage storage is not initialized')
    return this.domain
  }

  private requireInboundTable(): InboundTable {
    if (this.inbound === undefined) throw new Error('dsh-imessage dedupe storage is not initialized')
    return this.inbound
  }

  private requireRoutes(): RouteManager {
    if (this.routes === undefined) throw new Error('dsh-imessage routes are not initialized')
    return this.routes
  }
}

function accountView(account: {
  id: string
  email: string
  name?: string | undefined
}): PhotonAccountView {
  return {
    id: account.id,
    email: account.email,
    ...(account.name === undefined ? {} : { name: account.name }),
  }
}

function validateSettings(settings: PluginSettings): void {
  for (const route of normalizeRoutes(settings)) {
    if (route.workspaceCwd !== undefined && unwrapCopiedPath(route.workspaceCwd).length > 0) {
      if (!route.workspaceCwd.includes('\0') && !isAbsolutePathShape(route.workspaceCwd)) {
        throw new Error('workspaceCwd must be an absolute path when set')
      }
    }
  }
}

function assertAuthorizationActive(current: number, actual: number, signal: AbortSignal): void {
  if (current !== actual || signal.aborted) throw new DOMException('Authorization cancelled', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export default DshPhotonImessageService

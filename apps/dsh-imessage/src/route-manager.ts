import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.js'
import type { RouteSettings } from './routes.js'
import { routeDisplayLabel } from './routes.js'
import { SessionRouter, type ActiveSessionStore } from './session-router.js'
import {
  createSpectrumConnection,
  SpectrumSupervisor,
  type SpectrumConnectionConfig,
  type SpectrumInboundMessage,
} from './spectrum-runtime.js'
import { resolveWorkspaceCwd } from './workspace.js'
import type { ImessageRouteState, RuntimeView } from './types.js'

interface RouteBinding {
  routeId: string
  router: SessionRouter
  spectrum: SpectrumSupervisor
  runtime: RuntimeView
}

/** Manages one Spectrum listener + SessionRouter per configured iMessage route. */
export class RouteManager {
  private readonly bindings = new Map<string, RouteBinding>()
  private inboundTail = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly activeStoreFor: (routeId: string) => ActiveSessionStore,
    private readonly onInbound: (routeId: string, message: SpectrumInboundMessage) => Promise<void>,
  ) {}

  /** Snapshot every route for the settings page. */
  async project(routes: RouteSettings[]): Promise<ImessageRouteState[]> {
    const projected: ImessageRouteState[] = []
    for (const route of routes) {
      const binding = this.bindings.get(route.id)
      let workspaceCwd = process.cwd()
      try {
        workspaceCwd = await resolveWorkspaceCwd(route.workspaceCwd)
      } catch {
        workspaceCwd = binding?.router.cwd ?? process.cwd()
      }
      const activeSessionId = this.activeStoreFor(route.id).get()
      projected.push({
        id: route.id,
        label: routeDisplayLabel(route),
        workspaceCwd,
        photonProjectName: route.photonProjectName,
        runtime: binding?.runtime ?? { phase: 'stopped' },
        ...(route.phoneNumber === undefined ? {} : { phoneNumber: route.phoneNumber }),
        ...(route.assignedPhoneNumber === undefined
          ? {}
          : { assignedPhoneNumber: route.assignedPhoneNumber }),
        ...(activeSessionId === undefined ? {} : { activeSessionId }),
      })
    }
    return projected
  }

  /** Ensure a binding exists for the route with the resolved workspace cwd. */
  async ensureBinding(route: RouteSettings): Promise<RouteBinding> {
    const existing = this.bindings.get(route.id)
    const workspaceCwd = await resolveWorkspaceCwd(route.workspaceCwd).catch(() => process.cwd())
    if (existing !== undefined) {
      if (existing.router.cwd !== workspaceCwd) {
        existing.router.setCwd(workspaceCwd)
        await existing.router.reset()
      }
      return existing
    }

    const router = new SessionRouter(this.ctx, this.activeStoreFor(route.id), {
      cwd: workspaceCwd,
      sessionsPerPage: this.config.sessionsPerPage,
      maxOutboundChars: this.config.maxOutboundChars,
      maxOutboundMediaBytes: this.config.maxOutboundMediaBytes,
      interactionTimeoutMs: this.config.interactionTimeoutMs,
    })
    const spectrum = new SpectrumSupervisor(createSpectrumConnection, {
      reconnectMinMs: this.config.reconnectMinMs,
      reconnectMaxMs: this.config.reconnectMaxMs,
      onState: state => {
        const binding = this.bindings.get(route.id)
        if (binding === undefined) return
        binding.runtime = state
        binding.router.setRuntimeHealthy(state.phase === 'listening')
      },
      onMessage: message => this.receive(route.id, message),
    })
    const binding: RouteBinding = {
      routeId: route.id,
      router,
      spectrum,
      runtime: spectrum.state,
    }
    this.bindings.set(route.id, binding)
    return binding
  }

  /** Start or restart Spectrum for one fully provisioned route. */
  async startRoute(route: RouteSettings, connection: SpectrumConnectionConfig): Promise<void> {
    const binding = await this.ensureBinding(route)
    await binding.spectrum.restart(connection)
  }

  /** Prepare a Spectrum connection for one route without disturbing the live listener. */
  async prepareRoute(
    route: RouteSettings,
    connection: SpectrumConnectionConfig,
  ): Promise<{ binding: RouteBinding; prepared: Awaited<ReturnType<SpectrumSupervisor['prepare']>> }> {
    const binding = await this.ensureBinding(route)
    const prepared = await binding.spectrum.prepare(connection)
    return { binding, prepared }
  }

  /** Activate a previously prepared Spectrum connection on one route. */
  async activateRoute(
    routeId: string,
    connection: SpectrumConnectionConfig,
    prepared: Awaited<ReturnType<SpectrumSupervisor['prepare']>>,
  ): Promise<void> {
    const binding = this.require(routeId)
    await binding.spectrum.activate(connection, prepared)
  }

  /** Stop Spectrum and clear session selection for one route. */
  async stopRoute(routeId: string, resetSession = true): Promise<void> {
    const binding = this.bindings.get(routeId)
    if (binding === undefined) return
    await binding.spectrum.stop()
    if (resetSession) await binding.router.reset()
  }

  /** Remove one route binding entirely. */
  async disposeRoute(routeId: string): Promise<void> {
    const binding = this.bindings.get(routeId)
    if (binding === undefined) return
    this.bindings.delete(routeId)
    await binding.spectrum.stop()
    await binding.router.close()
  }

  /** Stop every route listener and router. */
  async close(): Promise<void> {
    await this.inboundTail.catch(() => {})
    for (const routeId of [...this.bindings.keys()]) await this.disposeRoute(routeId)
  }

  /** Reset every route session selection and stop listeners. */
  async resetAll(): Promise<void> {
    for (const binding of this.bindings.values()) {
      await binding.spectrum.stop()
      await binding.router.reset()
    }
  }

  /** Retry Spectrum for one route using a provided connection config. */
  async retry(routeId: string, connection: SpectrumConnectionConfig): Promise<void> {
    const binding = this.require(routeId)
    await binding.spectrum.restart(connection)
  }

  require(routeId: string): RouteBinding {
    const binding = this.bindings.get(routeId)
    if (binding === undefined) throw new Error(`iMessage route ${routeId} is not initialized`)
    return binding
  }

  get(routeId: string): RouteBinding | undefined {
    return this.bindings.get(routeId)
  }

  private receive(routeId: string, message: SpectrumInboundMessage): Promise<void> {
    const result = this.inboundTail.then(() => this.onInbound(routeId, message))
    this.inboundTail = result.catch(() => {})
    return result
  }
}

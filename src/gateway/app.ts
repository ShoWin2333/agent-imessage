import { realpath, stat } from 'node:fs/promises'
import type { AppConfig, Secrets } from '../app/config.js'
import { StateStore } from './state.js'
import { GatewayRouter } from './router.js'
import { SpectrumSupervisor, createSpectrumConnection, type SpectrumConnectionFactory } from '../spectrum-runtime.js'
import { AppServer, CodexBackend } from '../backends/codex.js'
import { IsolatedCursorBackend } from '../backends/isolated-cursor.js'
import { DshBackend } from '../backends/dsh.js'
import type { Backend } from '../backends/types.js'
import type { RouteConfig } from './config.js'

export type BackendFactory = (route: RouteConfig, config: AppConfig, secrets: Secrets) => Backend
export const createBackend: BackendFactory = (route, config, secrets) => {
  const privateNames = config.routes.flatMap(r => [r.projectSecretEnv, r.cursorApiKeyEnv ?? 'CURSOR_API_KEY'])
  switch (route.backend ?? 'codex') {
    case 'cursor': return new IsolatedCursorBackend(route, (route.cursorApiKeyEnv ? process.env[route.cursorApiKeyEnv] : secrets.cursorApiKey || process.env.CURSOR_API_KEY) || '', privateNames)
    case 'dsh': return DshBackend.spawn(config.dshBinary, route.cwd, privateNames)
    case 'codex': return new CodexBackend(new AppServer(config.codexBinary, route.cwd, privateNames))
  }
}
interface Runtime { router: GatewayRouter; supervisor: SpectrumSupervisor; store: StateStore }
/** Sole owner of listeners, route state, adapters and shutdown. Operations are serialized. */
export class Gateway {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly errors = new Map<string, string>()
  private operation = Promise.resolve()
  constructor(private config: AppConfig, private secrets: Secrets, private readonly backendFactory = createBackend, private readonly connectionFactory: SpectrumConnectionFactory = createSpectrumConnection) {}
  snapshot() {
    return this.config.routes.map(route => {
      const runtime = this.runtimes.get(route.id)
      return { id: route.id, backend: route.backend ?? 'codex', phase: this.errors.has(route.id) ? 'failed' : runtime?.supervisor.state.phase ?? 'stopped', error: this.errors.get(route.id), ...runtime?.router.snapshot() }
    })
  }
  start(): Promise<void> { return this.enqueue(() => this.startAll()) }
  stop(): Promise<void> { return this.enqueue(() => this.stopAll()) }
  replace(config: AppConfig, secrets: Secrets): Promise<void> {
    return this.enqueue(async () => { await this.stopAll(); this.config = config; this.secrets = secrets; await this.startAll() })
  }
  replaceRoute(id: string, config: AppConfig, secrets: Secrets): Promise<void> {
    return this.enqueue(async () => {
      const runtime = this.runtimes.get(id)
      if (runtime) {
        await runtime.supervisor.stop()
        await runtime.router.close()
        await runtime.store.close()
        this.runtimes.delete(id)
      }
      this.errors.delete(id)
      this.config = config; this.secrets = secrets
      await this.startAll(id)
    })
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.operation.then(work)
    this.operation = result.catch(() => {})
    return result
  }
  private async startAll(onlyId?: string): Promise<void> {
    for (const route of this.config.routes) {
      if (onlyId !== undefined && route.id !== onlyId) continue
      if (route.enabled === false || this.runtimes.has(route.id)) continue
      this.errors.delete(route.id)
      let store: StateStore | undefined, backend: Backend | undefined, supervisor: SpectrumSupervisor | undefined, router: GatewayRouter | undefined
      try {
        route.cwd = await realpath(route.cwd)
        if (!(await stat(route.cwd)).isDirectory()) throw new Error('Workspace must be a directory')
        const projectSecret = this.secrets.photon[route.id] || process.env[route.projectSecretEnv]
        if (!projectSecret) throw new Error('Missing Photon secret')
        store = await StateStore.open(this.config.stateDir, route)
        backend = this.backendFactory(route, this.config, this.secrets)
        router = new GatewayRouter(backend, route, store)
        const target = router
        supervisor = new SpectrumSupervisor(this.connectionFactory, {
          reconnectMinMs: 1000, reconnectMaxMs: 60_000,
          onState: state => target.setConnected(state.phase === 'listening'), onMessage: message => target.receive(message),
        })
        const connection = supervisor, closed = backend.onClose
        backend.onClose = () => { closed(); this.errors.set(route.id, 'Backend stopped. Check local authentication, then restart.'); void connection.stop() }
        await backend.initialize()
        this.runtimes.set(route.id, { router, supervisor, store })
        await supervisor.restart({ ...route, projectSecret })
      } catch {
        if (router) await router.close(); else await backend?.close()
        await supervisor?.stop(); await store?.close()
        this.runtimes.delete(route.id)
        this.errors.set(route.id, 'Could not start route. Check workspace, credentials, executable and state lock.')
      }
    }
  }
  private async stopAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.supervisor.stop()
      await runtime.router.close()
      await runtime.store.close()
    }
    this.runtimes.clear(); this.errors.clear()
  }
}

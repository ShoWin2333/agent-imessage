import { createHash } from 'node:crypto'
import type { ChannelAdapter } from '../channels/types.js'
import { IMessageAdapter } from '../channels/imessage.js'
import { WeixinAdapter } from '../channels/weixin.js'

import { realpath, stat } from 'node:fs/promises'
import type { AppConfig, Secrets } from '../app/config.js'
import { StateStore } from './state.js'
import { GatewayRouter } from './router.js'
import { createSpectrumConnection, type SpectrumConnectionFactory } from '../spectrum-runtime.js'
import { AppServer, CodexBackend } from '../backends/codex.js'
import { IsolatedCursorBackend } from '../backends/isolated-cursor.js'
import { DshBackend } from '../backends/dsh.js'
import type { Backend } from '../backends/types.js'
import { routeChannels, photonSecretKey, type RouteConfig } from './config.js'

export type BackendFactory = (route: RouteConfig, config: AppConfig, secrets: Secrets) => Backend
export const createBackend: BackendFactory = (route, config, secrets) => {
  const privateNames = config.routes.flatMap(r => [...routeChannels(r).flatMap(c=>c.kind === 'imessage' ? [c.projectSecretEnv] : []), r.cursorApiKeyEnv ?? 'CURSOR_API_KEY'])
  switch (route.backend ?? 'codex') {
    case 'cursor': return new IsolatedCursorBackend(route, (route.cursorApiKeyEnv ? process.env[route.cursorApiKeyEnv] : secrets.cursorApiKey || process.env.CURSOR_API_KEY) || '', privateNames)
    case 'dsh': return DshBackend.spawn(config.dshBinary, route.cwd, privateNames)
    case 'codex': return new CodexBackend(new AppServer(config.codexBinary, route.cwd, privateNames))
  }
}

interface Runtime { routeId: string; channelId: string; router: GatewayRouter; adapter: ChannelAdapter; store: StateStore }
/** Sole owner of listeners, route state, adapters and shutdown. Operations are serialized. */
export class Gateway {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly errors = new Map<string, string>()
  private operation = Promise.resolve()
  constructor(private config: AppConfig, private secrets: Secrets, private readonly backendFactory = createBackend, private readonly connectionFactory: SpectrumConnectionFactory = createSpectrumConnection) {}
  snapshot() {
    return this.config.routes.map(route => {
      const channels = routeChannels(route).map(channel => {
        const key = this.key(route,channel.id), runtime = this.runtimes.get(key)
        return {id:channel.id, kind:channel.kind, phase:this.errors.has(key) ? 'failed' : runtime?.adapter.state.phase ?? 'stopped',
          error:this.errors.get(key) ?? (runtime?.adapter.state.phase === 'failed' ? runtime.adapter.state.error?.message : undefined), ...runtime?.router.snapshot()}
      })
      const first = channels[0]!
      return { ...first, id:route.id, backend:route.backend ?? 'codex', channels,
        phase:channels.every(c => c.phase === 'listening') ? 'listening' : channels.some(c => c.phase === 'failed') ? 'failed' : channels.find(c=>c.phase !== 'listening')?.phase ?? 'stopped',
        busy:channels.some(c => c.busy), pending:channels.reduce((n,c)=>n+(c.pending ?? 0),0), receivedCount:channels.reduce((n,c)=>n+(c.receivedCount ?? 0),0) }
    })
  }
  private key(route: RouteConfig, channelId: string) { return route.channels ? `${route.id}:${channelId}` : route.id }
  start(): Promise<void> { return this.enqueue(() => this.startAll()) }
  stop(): Promise<void> { return this.enqueue(() => this.stopAll()) }
  replace(config: AppConfig, secrets: Secrets): Promise<void> {
    return this.enqueue(async () => { await this.stopAll(); this.config = config; this.secrets = secrets; await this.startAll() })
  }
  replaceRoute(id: string, config: AppConfig, secrets: Secrets): Promise<void> {
    return this.enqueue(async () => {
      for (const [key,runtime] of this.runtimes) {
        if (runtime.routeId !== id) continue
        await runtime.adapter.stop()
        await runtime.router.close()
        await runtime.store.close()
        this.runtimes.delete(key)
      }
      for (const key of this.errors.keys()) if (key === id || key.startsWith(`${id}:`)) this.errors.delete(key)
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
      if (route.enabled === false) continue
      for (const channel of routeChannels(route)) {
        const key = this.key(route,channel.id)
        if (this.runtimes.has(key)) continue
        this.errors.delete(key)
        let store: StateStore | undefined, backend: Backend | undefined, adapter: ChannelAdapter | undefined, router: GatewayRouter | undefined
        try {
          const cwd = await realpath(route.cwd)
          if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory')
          const credential = channel.kind === 'weixin' && Object.hasOwn(this.secrets.weixin ?? {},channel.accountId) ? this.secrets.weixin![channel.accountId] : undefined
          if (channel.kind === 'weixin' && (!credential || credential.accountId !== channel.accountId)) throw new Error('Bind Weixin first')
          const projectSecret = channel.kind === 'imessage' ? this.secrets.photon[photonSecretKey(route,channel)] || process.env[channel.projectSecretEnv] : undefined
          if (channel.kind === 'imessage' && !projectSecret) throw new Error('Missing Photon secret')
          // Legacy iMessage routes keep their original state and lock names. New bindings
          // have independent backend instances, state, dedupe and approval ownership.
          const legacyIdentity = channel.kind === 'imessage' && channel.id === 'imessage' && route.projectId === channel.projectId && route.senderPhoneNumber === channel.senderPhoneNumber && route.assignedPhoneNumber === channel.assignedPhoneNumber
          const isolated = {...route,cwd,...(channel.kind === 'imessage' ? channel : {projectId:'',projectSecretEnv:'',senderPhoneNumber:'',assignedPhoneNumber:''}),id:route.channels && !legacyIdentity ? createHash('sha256').update(key).digest('hex') : route.id}
          const identity = route.channels && !legacyIdentity ? JSON.stringify([channel.kind,channel.id,channel.kind === 'weixin' ? [channel.accountId,credential!.ownerUserId] : []]) : undefined
          store = await StateStore.open(this.config.stateDir,isolated,identity)
          backend = this.backendFactory(isolated,this.config,this.secrets)
          router = new GatewayRouter(backend,isolated,store)
          const target = router
          if (channel.kind === 'imessage') {
            adapter = new IMessageAdapter({...channel,projectSecret:projectSecret!},message=>target.receive(message),state=>target.setConnected(state.phase === 'listening'),this.connectionFactory)
          } else {
            adapter = new WeixinAdapter(credential!,store,message=>target.receive(message),state=>target.setConnected(state.phase === 'listening'))
          }
          const connection = adapter, closed = backend.onClose
          backend.onClose = () => { closed(); this.errors.set(key,'Backend stopped. Check local authentication, then restart.'); void connection.stop() }
          await backend.initialize()
          this.runtimes.set(key,{routeId:route.id,channelId:channel.id,router,adapter,store})
          await adapter.start()
        } catch {
          await adapter?.stop()
          if (router) await router.close(); else await backend?.close()
          await store?.close()
          this.runtimes.delete(key)
          this.errors.set(key, 'Channel failed. Check workspace, backend credentials and channel binding.')
        }
      }
    }
  }
  private async stopAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.adapter.stop()
      await runtime.router.close()
      await runtime.store.close()
    }
    this.runtimes.clear(); this.errors.clear()
  }
}

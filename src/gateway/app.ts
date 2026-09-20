import { PluginError } from '../errors.js'
import { ScheduleJournal } from './schedule-journal.js'
import { cronMatches, nextRuns } from './cron.js'
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
  private readonly history = new Map<string,ReturnType<GatewayRouter['snapshot']>>()
  private readonly errors = new Map<string, string>()
  private operation = Promise.resolve()
  private scheduler: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private readonly journal: ScheduleJournal
  private readonly nextTimes = new Map<string,{minute:number;time:number | undefined}>()
  private readonly updating = new Set<string>()
  private readonly workspaces = new Set<string>()
  constructor(private config: AppConfig, private secrets: Secrets, private readonly backendFactory = createBackend, private readonly connectionFactory: SpectrumConnectionFactory = createSpectrumConnection) { this.journal = new ScheduleJournal(config.stateDir) }
  snapshot() {
    return this.config.routes.map(route => {
      const channels = routeChannels(route).map(channel => {
        const key = this.key(route,channel.id), runtime = this.runtimes.get(key)
        return {id:channel.id, kind:channel.kind, phase:this.errors.has(key) ? 'failed' : runtime?.adapter.state.phase ?? 'stopped',
          error:this.errors.get(key) ?? (runtime?.adapter.state.phase === 'failed' ? runtime.adapter.state.error?.message : undefined), ...(runtime?.router.snapshot() ?? this.history.get(key))}
      })
      const {tasks: _tasks, activity: _activity, requests: _requests, ...first} = channels[0] ?? {}
      return { ...first, id:route.id, backend:route.backend ?? 'codex', channels,
        schedules:(route.schedules ?? []).map(task => {
          const key = JSON.stringify([task.cron,task.timeZone]), minute = Math.floor(Date.now()/60000)
          let next = this.nextTimes.get(key)
          if (!next || next.minute !== minute) { next = {minute,time:nextRuns(task.cron,task.timeZone,new Date(),1)[0]}; this.nextTimes.set(key,next) }
          return {id:task.id,nextAt:task.enabled ? next.time : undefined,last:this.journal.outcomes[`${route.id}:${task.id}`]}
        }),
        phase:channels.every(c => c.phase === 'listening') ? 'listening' : channels.some(c => c.phase === 'failed') ? 'failed' : channels.find(c=>c.phase !== 'listening')?.phase ?? 'stopped',
        busy:channels.some(c => c.busy), pending:channels.reduce((n,c)=>n+(c.pending ?? 0),0), receivedCount:channels.reduce((n,c)=>n+(c.receivedCount ?? 0),0) }
    })
  }
  private key(route: RouteConfig, channelId: string) { return route.channels ? `${route.id}:${channelId}` : route.id }
  start(): Promise<void> { return this.enqueue(() => this.startAll()) }
  stop(): Promise<void> { return this.enqueue(() => this.stopAll()) }
  /** Validate before persisting; configuration never interrupts a running task. */
  validateUpdate(config: AppConfig, secrets: Secrets): void {
    for (const old of this.config.routes) {
      const next = config.routes.find(r => r.id === old.id)
      if (this.needsRestart(old,next,secrets) && [...this.runtimes.values()].some(r => r.routeId === old.id && (r.router.snapshot().busy || r.store.state.tasks?.some(t => t.delivery === 'sending')))) throw new PluginError('busy','请先停止该项目的任务，再修改执行配置。名称、头像和计划可随时保存。')
    }
  }
  private needsRestart(old: RouteConfig, next: RouteConfig | undefined, secrets: Secrets): boolean {
    const execution = (r: RouteConfig) => { const {label,avatar,schedules,model,effort,speed,...rest} = r; return rest }
    return !next || JSON.stringify(execution(old)) !== JSON.stringify(execution(next)) ||
      (old.backend === 'cursor' && !old.cursorApiKeyEnv && this.secrets.cursorApiKey !== secrets.cursorApiKey) ||
      routeChannels(old).some(c => c.kind === 'imessage' ? this.secrets.photon[photonSecretKey(old,c)] !== secrets.photon[photonSecretKey(old,c)] : JSON.stringify(this.secrets.weixin?.[c.accountId]) !== JSON.stringify(secrets.weixin?.[c.accountId]))
  }
  replace(config: AppConfig, secrets: Secrets, persist: () => Promise<void> = async () => {}): Promise<void> {
    return this.enqueue(async () => {
      this.validateUpdate(config,secrets)
      for (const old of this.config.routes) if (this.needsRestart(old,config.routes.find(r => r.id === old.id),secrets)) this.updating.add(old.id)
      try {
      await persist()
      for (const old of this.config.routes) {
        const next = config.routes.find(r => r.id === old.id)
        if (!this.needsRestart(old,next,secrets)) {
          if (next && [old.model,old.effort,old.speed].join() !== [next.model,next.effort,next.speed].join()) for (const runtime of this.runtimes.values()) if (runtime.routeId === old.id) runtime.router.updateModel(next)
          continue
        }
        for (const [key,runtime] of this.runtimes) {
          if (runtime.routeId !== old.id) continue
          await runtime.adapter.stop(); await runtime.router.close(); await runtime.store.close()
          this.runtimes.delete(key)
          this.history.delete(key)
        }
        for (const key of this.errors.keys()) if (key === old.id || key.startsWith(`${old.id}:`)) this.errors.delete(key)
      }
      this.config = config; this.secrets = secrets
      await this.startAll()
      } finally { this.updating.clear() }
    })
  }
  replaceRoute(_id: string, config: AppConfig, secrets: Secrets): Promise<void> { return this.replace(config,secrets) }
  async control(routeId: string, channelId: string, taskId: string, action: string, requestId?: string, answers?: Record<string,string>): Promise<void> {
    const runtime = [...this.runtimes.values()].find(r => r.routeId === routeId && r.channelId === channelId)
    if (!runtime || this.updating.has(routeId)) throw new PluginError('busy','入口不可用或正在更新，请稍后重试。')
    if (action === 'resend') {
      const task = runtime.store.state.tasks?.find(t => t.id === taskId)
      if (!task || !runtime.adapter.scheduledMessage || runtime.adapter.state.phase !== 'listening') throw new Error('结果或发送入口不可用')
      const channel = await runtime.adapter.scheduledMessage(`resend:${task.id}`,task.input)
      if (![...this.runtimes.values()].includes(runtime) || this.updating.has(routeId)) throw new PluginError('busy','入口已更新，请刷新后重试。')
      await runtime.router.deliver(task,channel)
    } else await runtime.router.control(taskId,action,requestId,answers)
  }
  async runSchedule(routeId: string, scheduleId: string): Promise<void> {
    const route = this.config.routes.find(r => r.id === routeId)
    const task = route?.schedules?.find(s => s.id === scheduleId)
    if (!route || !task) throw new Error('计划不存在')
    const runtime = this.runtimes.get(this.key(route,task.channelId))
    if (!runtime?.adapter.scheduledMessage) throw new Error('入口不可用')
    await runtime.router.schedule({...task,id:`trial-${task.id}-${Date.now()}`},Math.floor(Date.now()/60000),() => runtime.adapter.scheduledMessage!(`trial:${Date.now()}`,task.prompt),false)
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.operation.then(work)
    this.operation = result.catch(() => {})
    return result
  }
  private async startAll(onlyId?: string): Promise<void> {
    await this.journal.load()
    if (!this.scheduler) {
      this.scheduler = setInterval(() => {
        if (this.ticking) return
        this.ticking = true
        void this.enqueue(() => this.tickSchedules()).catch(() => {}).finally(() => {this.ticking = false})
      }, 5000)
      this.scheduler.unref()
    }
    for (const route of this.config.routes) {
      if (onlyId !== undefined && route.id !== onlyId) continue
      if (route.enabled === false) continue
      for (const channel of routeChannels(route)) {
        const key = this.key(route,channel.id)
        if (this.runtimes.has(key)) continue
        this.errors.delete(key)
        let store: StateStore | undefined, backend: Backend | undefined, adapter: ChannelAdapter | undefined, router: GatewayRouter | undefined
        let stage = '工作目录'
        try {
          const cwd = await realpath(route.cwd)
          if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory')
          stage = '渠道凭据与绑定'
          const credential = channel.kind === 'weixin' && Object.hasOwn(this.secrets.weixin ?? {},channel.accountId) ? this.secrets.weixin![channel.accountId] : undefined
          if (channel.kind === 'weixin' && (!credential || credential.accountId !== channel.accountId)) throw new Error('Bind Weixin first')
          const projectSecret = channel.kind === 'imessage' ? this.secrets.photon[photonSecretKey(route,channel)] || process.env[channel.projectSecretEnv] : undefined
          if (channel.kind === 'imessage' && !projectSecret) throw new Error('Missing Photon secret')
          // Legacy iMessage routes keep their original state and lock names. New bindings
          // have independent backend instances, state, dedupe and approval ownership.
          const legacyIdentity = channel.kind === 'imessage' && channel.id === 'imessage' && route.projectId === channel.projectId && route.senderPhoneNumber === channel.senderPhoneNumber && route.assignedPhoneNumber === channel.assignedPhoneNumber
          const isolated = {...route,cwd,...(channel.kind === 'imessage' ? channel : {projectId:'',projectSecretEnv:'',senderPhoneNumber:'',assignedPhoneNumber:''}),id:route.channels && !legacyIdentity ? createHash('sha256').update(key).digest('hex') : route.id}
          const identity = route.channels && !legacyIdentity ? JSON.stringify([channel.kind,channel.id,channel.kind === 'weixin' ? [channel.accountId,credential!.ownerUserId] : []]) : undefined
          stage = '私有状态存储'
          store = await StateStore.open(this.config.stateDir,isolated,identity)
          stage = 'Agent 后端'
          backend = this.backendFactory(isolated,this.config,this.secrets)
          router = new GatewayRouter(backend,isolated,store,600_000,20_000,() => {
            if (this.updating.has(route.id) || this.workspaces.has(cwd)) return undefined
            this.workspaces.add(cwd)
            return () => { this.workspaces.delete(cwd) }
          })
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
          stage = '消息渠道连接'
          await adapter.start()
        } catch {
          await adapter?.stop()
          if (router) await router.close(); else await backend?.close()
          await store?.close()
          if (router) this.history.set(key,router.snapshot())
          this.runtimes.delete(key)
          this.errors.set(key, `启动失败（${stage}）。请检查该环节的本机配置后重试。`)
        }
      }
    }
  }
  /** No catch-up: sleep/offline slots are skipped; each current minute is claimed durably. */
  async tickSchedules(now = new Date()): Promise<void> {
    await this.journal.load()
    const minute = Math.floor(now.getTime() / 60_000)
    const previous = this.journal.lastMinute
    if (previous !== undefined && minute <= previous) return
    this.journal.lastMinute = minute
    // Claim the clock slot before side effects; never replay after a crash.
    await this.journal.save()
    for (const route of this.config.routes) {
      if (route.enabled === false) continue
      for (const task of route.schedules ?? []) {
        if (!task.enabled) continue
        const outcomeKey = `${route.id}:${task.id}`
        if (previous !== undefined && minute > previous + 1) {
          const missed = nextRuns(task.cron,task.timeZone,new Date(previous*60000),1)[0]
          if (missed !== undefined && missed < minute*60000) this.journal.outcomes[outcomeKey] = {at:now.getTime(),status:'skipped',detail:'服务暂停、电脑睡眠或停机期间错过执行时间，不补跑。'}
        }
        if (!cronMatches(task.cron,task.timeZone,now)) continue
        const runtime = this.runtimes.get(this.key(route,task.channelId))
        if (!runtime) { this.journal.outcomes[outcomeKey] = {at:now.getTime(),status:'skipped',detail:'消息入口未启动或启动失败，不补跑。'}; continue }
        const busy = [...this.runtimes.values()].some(r => r.routeId === route.id && r.router.snapshot().busy)
        await runtime.router.schedule(task,minute,async () => {
          if (!runtime.adapter.scheduledMessage) throw new Error('Proactive delivery unavailable')
          return runtime.adapter.scheduledMessage(`cron:${task.id}:${minute}`,task.prompt)
        },busy)
        const activity = runtime.router.snapshot().activity.filter(a => a.messageId === `cron:${task.id}:${minute}`).at(-1)
        this.journal.outcomes[outcomeKey] = {at:now.getTime(),status:activity?.stage === 'schedule-skipped' || activity?.stage === 'busy' ? 'skipped' : 'submitted',detail:activity?.text ?? '已提交，执行结果见任务页。'}
      }
    }
    await this.journal.save()
  }
  private async stopAll(): Promise<void> {
    clearInterval(this.scheduler); this.scheduler = undefined
    for (const [key,runtime] of this.runtimes) {
      await runtime.adapter.stop()
      await runtime.router.close()
      await runtime.store.close()
      this.history.set(key,runtime.router.snapshot())
    }
    this.runtimes.clear(); this.errors.clear()
  }
}

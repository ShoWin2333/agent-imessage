import {requestId, interactionPresentation} from './interaction.js'
import { taskSummary } from './task-history.js'
import { PluginError } from '../errors.js'
import type { ScheduledTask } from './cron.js'
import { failureText } from '../backends/failure.js'
import { gatewayTools as tools } from './tools.js'
import { randomUUID } from 'node:crypto'
import { chunkText } from '../chunks.js'
import { markdownToPlainText } from '../plaintext.js'
import { loadOutboundMedia, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../media.js'
import type { ChannelMessage } from '../channels/types.js'
import type { RouteConfig } from './config.js'
import { object, SessionInUseError, type ObjectValue } from '../backends/jsonrpc.js'
import type { Backend, BackendEvent, BackendRequest } from '../backends/types.js'
import type { TaskRecord, RouteState } from './state.js'

interface Store { pinTask?(id: string): () => void; archivedCount?: number; state: RouteState; save(): Promise<void> }
interface Active {
  task: TaskRecord
  release(): void
  sessionId?: string
  channel: ChannelMessage
  turnId?: string
  startedAt: number
  phase: string
  phaseAt: number
  firstActivityAt?: number
  firstTextAt?: number
  runId?: string
  stopping: boolean
  abort: AbortController
  answers: Map<string, string>
  changes: Map<string, unknown>
}
interface Pending {
  presentation: ReturnType<typeof interactionPresentation>
  details: string
  expiresAt: number
  kind: 'approval' | 'question'
  resolve(value: unknown): void
  cancel(): void
  questions: string[]
}


/** One route owns one thread and at most one turn. Busy prompts are rejected, never silently queued. */
export class GatewayRouter {
  private active: Active | undefined
  private nextRoute: RouteConfig | undefined
  updateModel(route: RouteConfig): void { this.nextRoute = {...this.route, model:route.model, effort:route.effort, speed:route.speed} as RouteConfig }
  private readonly activity: Array<{ sequence: number; at: number; messageId?: string; stage: string; text?: string; itemId?: string }> = []
  private activitySequence = 0
  private historyTimer: ReturnType<typeof setTimeout> | undefined
  private readonly deliveries = new Set<Promise<void>>()
  private outgoing: Promise<void> = Promise.resolve()
  private syncHistory(): void { this.store.state.activity = this.activity.map(entry => ({...entry})) }
  private persistHistory(): void {
    this.syncHistory()
    if (this.closed || this.historyTimer) return
    this.historyTimer = setTimeout(() => {
      this.historyTimer = undefined
      void this.store.save().catch(() => {})
    }, 1000)
    this.historyTimer.unref()
  }
  private duration(start: number): string { return ((Date.now() - start) / 1000).toFixed(1) + ' 秒' }
  private progress(active: Active, phase: string): void {
    active.phase = phase; active.phaseAt = Date.now()
  }
  private record(stage: string, channel?: ChannelMessage, text?: string, itemId?: string): void {
    this.activity.push({ sequence: ++this.activitySequence, at: Date.now(), stage,
      ...(itemId ? {itemId} : {}), ...(channel ? {messageId: channel.id} : {}), ...(text ? {text: text.slice(0, 8000) + (text.length > 8000 ? '\n…（内容已截断）' : '')} : {}) })
    const task = this.active?.channel.id === channel?.id ? this.active?.task : undefined
    if (task && !['sending','sent','response'].includes(stage)) {
      task.workflow ??= []
      if (stage === 'preview') task.workflow = task.workflow.filter(e => e.stage !== 'preview' || e.itemId !== itemId)
      task.workflow.push({...this.activity.at(-1)!})
      if (task.workflow.length > 1000) { task.workflow.shift(); task.workflowTruncated = true }
    }
    if (this.activity.length > 200) this.activity.shift()
    this.persistHistory()
  }
  private receivedCount = 0
  private lastActivityAt: number | undefined
  private lastTurnStatus: 'completed' | 'interrupted' | 'failed' | undefined
  private ready = false
  private connected = false
  private closed = false
  private closing: Promise<void> | undefined
  private readonly pending = new Map<string, Pending>()
  private incoming: Promise<void> = Promise.resolve()
  private events: Promise<void> = Promise.resolve()

  constructor(private readonly backend: Backend, private route: RouteConfig, private readonly store: Store, private readonly interactionTimeoutMs = 600_000, private readonly waitNoticeMs = 20_000, private readonly acquire: () => (() => void) | undefined = () => () => {}) {
    this.activity.push(...(store.state.activity ?? []).slice(-200))
    this.activitySequence = Math.max(0, ...this.activity.map(entry => entry.sequence), ...(store.state.tasks ?? []).map(t=>t.workflow?.at(-1)?.sequence ?? 0))
    backend.onEvent = event => {
      this.events = this.events.then(() => this.notification(event)).catch(() => { this.record('error', this.active?.channel, '处理 Agent 事件失败。'); this.fail() })
    }
    backend.onRequest = request => this.serverRequest(request)
    backend.onClose = () => { if (this.active) { this.record('failed', this.active.channel, `后端连接已关闭。最后阶段：${this.active.phase}；总耗时 ${this.duration(this.active.startedAt)}。`); this.lastTurnStatus = 'failed' }; this.record('backend-closed', this.active?.channel); this.closed = true; this.cancelPending(); this.endActive('failed'); this.active = undefined }
  }

  private get agentName(): string { return this.route.backend === 'cursor' ? 'Cursor' : this.route.backend === 'dsh' ? 'DSH' : 'Codex' }

  snapshot() { return { sessions:this.store.state.sessions ?? [], archivedCount:this.store.archivedCount ?? 0, tasks: (this.store.state.tasks ?? []).map(taskSummary), requests: [...this.pending].map(([id,p]) => ({id,presentation:p.presentation,kind:p.kind,details:p.details,expiresAt:p.expiresAt,questions:p.questions})), busy: Boolean(this.active), current: this.active ? {taskId:this.active.task.id, messageId:this.active.channel.id, startedAt:this.active.startedAt, phase:this.active.phase, phaseAt:this.active.phaseAt, runId:this.active.runId} : undefined, sessionId: this.store.state.threadId, pending: this.pending.size, closed: this.closed, receivedCount: this.receivedCount, lastActivityAt: this.lastActivityAt, lastTurnStatus: this.lastTurnStatus, activity: this.activity.map(entry => ({...entry})) } }

  setConnected(value: boolean): void {
    if (this.connected !== value) this.record(value ? 'connected' : 'disconnected', this.active?.channel)
    this.connected = value
    if (!value && this.active) {
      this.active.task.reason = '消息入口断开，已请求中止执行。'
      this.active.stopping = true
      this.active.abort.abort()
      this.cancelPending()
      const turnId = this.active.turnId
      if (turnId) void this.backend.cancel(this.active.sessionId!, turnId).catch(() => { this.record('error', this.active?.channel, '处理 Agent 事件失败。'); this.fail() })
    }
  }

  async schedule(task: ScheduledTask, minute: number, getMessage: () => Promise<ChannelMessage>, projectBusy: boolean): Promise<void> {
    if ((this.store.state.scheduleRuns?.[task.id] ?? -1) >= minute) return
    this.store.state.scheduleRuns ??= {}
    this.store.state.scheduleRuns[task.id] = minute
    // Persist the claim before execution: a crash must never replay a task with side effects.
    await this.store.save()
    const id = `cron:${task.id}:${minute}`
    const marker = {id} as ChannelMessage
    this.record('scheduled', marker, `定时任务：${task.name}\n${task.prompt}`)
    if (projectBusy || this.active || this.closed || !this.connected) {
      this.record('schedule-skipped', marker, projectBusy || this.active ? '本次跳过：项目有任务运行，不会排队补跑。' : this.closed ? '本次跳过：执行后端已关闭，不会补跑。' : '本次跳过：消息入口尚未连接，不会补跑。'); return
    }
    let channel: ChannelMessage
    try { channel = await getMessage() }
    catch { this.record('schedule-skipped', marker, '本次跳过：无法建立主动回复通道。微信请先给机器人发一条消息；也请检查入口连接。'); return }
    await this.receive(channel, true, task.context !== 'shared')
  }

  submitDesktop(channel: ChannelMessage, sessionId: string | undefined, fresh = false): Promise<void> {
    const operation = this.incoming.then(async () => {
      if (this.store.state.tasks?.some(t=>t.messageId === channel.id)) return
      if (this.closed || !this.connected || this.active) throw new PluginError('busy','入口不可用或当前回复尚未结束，请稍后重试。')
      if (sessionId && !(this.store.state.sessions ?? []).includes(sessionId) && !(this.store.state.tasks ?? []).some(t=>t.sessionId === sessionId)) throw new PluginError('invalid-command','会话不属于此入口。')
      if (fresh || (sessionId && sessionId !== this.store.state.threadId)) {
        if (fresh) delete this.store.state.threadId; else if (sessionId) this.store.state.threadId = sessionId
        this.ready = false
        await this.store.save()
      }
      this.record('received',channel,channel.text)
      // Treat composer input as literal text, including leading slash commands.
      try { await this.handle(channel,true) }
      catch (error) {
        const active = this.active as Active | undefined
        if (active?.channel.id === channel.id) {
          active.task.reason = '建立会话或提交消息失败，请检查后端连接。'
          this.record('error',channel,active.task.reason)
          this.fail()
        }
        throw error
      }
      if (!this.store.state.tasks?.some(t=>t.messageId === channel.id)) throw new PluginError('busy','工作目录正被占用，请稍后重试。')
    })
    this.incoming = operation.catch(() => {})
    return operation
  }

  receive(channel: ChannelMessage, scheduled = false, isolated = false): Promise<void> {
    if (!scheduled) this.record('received', channel, channel.text)
    const operation = this.incoming.then(async () => {
      if (this.closed || !this.connected) { this.record('unavailable', channel); return }
      if (scheduled && this.active) { this.record('schedule-skipped', channel, '本次跳过：已有任务运行。'); return }
      if (this.store.state.seen.includes(channel.id)) { this.record('duplicate', channel); return }
      this.store.state.seen.push(channel.id)
      this.store.state.seen = this.store.state.seen.slice(-1024)
      await this.store.save()
      this.receivedCount++
      this.lastActivityAt = Date.now()
      await this.handle(channel, scheduled, isolated)
    })
    this.incoming = operation.catch(async error => {
      this.record('error', channel, '处理失败，请检查本机后端登录、连接和配置。')
      if (error instanceof SessionInUseError && !this.active?.turnId) {
        this.endActive('failed'); this.active = undefined
        this.ready = false
        await this.send(channel, 'This Codex session is in use by another client. Send /new to start a separate Gateway session, or release the session in the other client and retry.').catch(() => {})
        return
      }
      // Do not expose upstream errors, prompts or credentials to the remote channel.
      this.fail()
      await this.send(channel, 'Bridge stopped after an error. Check the local process and restart it; this message will not be replayed automatically.').catch(() => {})
    })
    return this.incoming
  }

  async close(): Promise<void> { this.record('stopped', this.active?.channel); this.fail(); await this.closing; await this.events; await Promise.allSettled(this.deliveries); clearTimeout(this.historyTimer); this.historyTimer = undefined; this.syncHistory(); await this.store.save() }

  private fail(): void {
    this.closed = true
    this.cancelPending()
    const active = this.active
    this.endActive('interrupted', false)
    this.active = undefined
    this.closing ??= this.backend.close().catch(() => {}).finally(() => active?.release())
  }

  private async handle(channel: ChannelMessage, scheduled = false, isolated = false): Promise<void> {
    const text = channel.text.trim()
    if (!text) return
    const [inputCommand, ...args] = text.split(/\s+/)
    const command = scheduled ? '' : inputCommand
    if (command === '/help') {
      await this.send(channel, 'Send a task as text. /new starts a fresh thread; /sessions lists this route’s sessions; /switch ID resumes one; /status shows this route; /stop interrupts; /approve ID or /deny ID answers an approval; /answer ID {"question-id":"answer"} answers questions. Use // for a prompt starting with /.')
      return
    }
    if (command === '/status') {
      await this.send(channel, `Route: ${this.route.id}\nAgent: ${this.agentName}\nThread: ${this.store.state.threadId ?? 'not started'}\nState: ${this.active ? (this.active.stopping ? 'stopping' : 'running') : 'idle'}\nPending questions/approvals: ${this.pending.size}${this.active ? `\n阶段：${this.active.phase}\n总等待：${this.duration(this.active.startedAt)}；当前阶段：${this.duration(this.active.phaseAt)}${this.active.runId ? `\nRun: ${this.active.runId}` : ''}` : ''}`)
      return
    }
    if (command === '/stop' || command === '/cancel') {
      const active = this.active
      if (!active) { await this.send(channel, 'No active turn.'); return }
      active.stopping = true
      active.abort.abort()
      this.cancelPending()
      if (active.turnId) await this.backend.cancel(active.sessionId!, active.turnId)
      await this.send(channel, `Stop requested. Waiting for ${this.agentName} to finish interrupting.`)
      return
    }
    if (command === '/approve' || command === '/deny' || command === '/answer') {
      await this.answer(channel, command, args)
      return
    }
    if (this.active) { this.record('busy', channel); await this.send(channel, 'A task is already running. Use /stop before starting another.'); return }
    if (command === '/sessions') {
      const ids = [...new Set([...(this.store.state.sessions ?? []), ...(this.store.state.threadId ? [this.store.state.threadId] : [])])]
      await this.send(channel, ids.length ? ids.map(id => `${id === this.store.state.threadId ? '* ' : ''}${id}`).join('\n') : 'No sessions for this route.')
      return
    }
    if (command === '/switch') {
      const id = args[0]
      if (args.length !== 1 || !id || !(this.store.state.sessions ?? []).includes(id)) { await this.send(channel, 'Choose a session ID from /sessions on this route.'); return }
      this.store.state.threadId = id
      this.ready = false
      await this.store.save()
      await this.send(channel, 'Session selected. Send your next task.')
      return
    }
    if (command === '/new') {
      delete this.store.state.threadId
      this.ready = false
      await this.store.save()
      await this.send(channel, `The next message will start a new ${this.agentName} thread.`)
      return
    }
    if (!scheduled && text.startsWith('/') && !text.startsWith('//')) { await this.send(channel, 'Unknown command. Send /help.'); return }
    if (this.nextRoute) { this.route = this.nextRoute; this.nextRoute = undefined; this.ready = false }
    const release = this.acquire()
    if (!release) { this.record('busy', channel, '该工作目录正由另一个任务使用。'); await this.send(channel, '该工作目录正由另一个任务使用，请稍后重试。'); return }
    const startedAt = Date.now()
    const task: TaskRecord = {workflow:[],...(channel.origin ? {origin:channel.origin} : {}),id:randomUUID(),messageId:channel.id,input:channel.text,startedAt,backend:this.route.backend ?? 'codex',cwd:this.route.cwd,...(this.route.effort ? {effort:this.route.effort} : {}),...(this.route.speed ? {speed:this.route.speed} : {}),...(this.route.approvalPolicy ? {approvalPolicy:this.route.approvalPolicy} : {}),...(this.route.model ? {model:this.route.model} : {}),execution:'running',delivery:'pending'}
    this.store.state.tasks ??= []
    this.store.state.tasks.push(task)
    const active: Active = { task, release, channel, startedAt, phase:'正在建立会话', phaseAt:startedAt, stopping: false, abort: new AbortController(), answers: new Map(), changes: new Map() }
    this.active = active
    await this.store.save()
    this.record('opening-session', channel)
    const notice = setTimeout(() => {
      void this.send(channel, `已收到任务，${this.agentName} 尚未完成。当前：${active.phase}。可发 /status 查看进度，或 /stop 取消。`, false,
        () => this.active === active && !active.stopping && this.connected && !this.pending.size).catch(() => {})
    }, this.waitNoticeMs)
    notice.unref()
    active.abort.signal.addEventListener('abort', () => clearTimeout(notice), {once:true})
    active.sessionId = await this.ensureThread(channel,isolated)
    if (this.active === active && active.stopping) {
      this.record('interrupted',channel,'建立会话期间已请求停止，未提交执行。')
      this.endActive('interrupted'); this.active = undefined
      return
    }
    if (this.active !== active || this.closed || !this.connected) {
      active.abort.abort()
      if (this.active === active) { this.record('interrupted', channel, '建立会话期间连接已断开，任务未提交。'); this.endActive('interrupted'); this.active = undefined }
      return
    }
    task.sessionId = active.sessionId
    await this.store.save()
    this.record('session-ready', channel, `建立／恢复会话耗时 ${this.duration(startedAt)}`)
    this.progress(active, '正在提交任务')
    void channel.responding(() => new Promise<void>(resolve => {
      if (active.abort.signal.aborted) resolve()
      else active.abort.signal.addEventListener('abort', () => resolve(), { once: true })
    })).catch(() => {})
    this.record('submitting', channel)
    const id = await this.backend.startTurn(active.sessionId!, !scheduled && text.startsWith('//') ? text.slice(1) : text)
    if (this.active !== active) return
    if (active.turnId && active.turnId !== id) throw new Error('Turn ownership mismatch')
    if (!active.turnId) this.record('accepted', channel)
    active.turnId = id
    if (active.stopping || !this.connected) await this.backend.cancel(active.sessionId!, id)
  }

  private async ensureThread(channel: ChannelMessage, isolated: boolean): Promise<string> {
    if (this.ready && !isolated) return this.store.state.threadId!
    const threadId = isolated ? undefined : this.store.state.threadId
    const thread = await this.backend.openSession({
      ...(threadId ? { id: threadId } : {}), tools:channel.nativeVoice === false ? tools.filter(t=>t.name !== 'send_imessage_voice') : tools, cwd: this.route.cwd,
      ...(this.route.approvalPolicy ? {approvalPolicy:this.route.approvalPolicy} : {}),
      ...(this.route.model ? { model: this.route.model } : {}),
      ...(this.route.speed && this.route.speed !== 'default' ? {speed:this.route.speed} : {}),
      ...(this.route.effort && this.route.effort !== 'default' ? { effort: this.route.effort } : {}),
    })
    if (typeof thread.id !== 'string' || thread.cwd !== this.route.cwd || (threadId && thread.id !== threadId)) throw new Error('Thread workspace mismatch')
    if (isolated) { this.ready = false; return thread.id }
    this.store.state.threadId = thread.id
    this.store.state.sessions = [...new Set([...(this.store.state.sessions ?? []), thread.id])].slice(-100)
    await this.store.save()
    this.ready = true
    return thread.id
  }

  private owns(params: ObjectValue): Active | undefined {
    const active = this.active
    if (!active || !active.turnId || params.threadId !== active.sessionId || params.turnId !== active.turnId) return undefined
    return active
  }

  private async notification(event: BackendEvent): Promise<void> {
    if (event.type === 'started' && this.active && event.sessionId === this.active.sessionId) {
      if (this.active.turnId && this.active.turnId !== event.turnId) { this.fail(); return }
      this.record('started', this.active.channel, '本地适配器已接单；尚不代表模型开始输出。')
      this.progress(this.active, '等待后端活动')
      this.active.turnId = event.turnId
      return
    }
    const active = this.owns({ threadId: event.sessionId, turnId: event.turnId })
    if (!active) return
    if (event.type === 'completed') {
      const unpin=this.store.pinTask?.(active.task.id)
      this.record(event.status, active.channel, `总耗时 ${this.duration(active.startedAt)}；${active.firstActivityAt ? `首个活动 ${((active.firstActivityAt-active.startedAt)/1000).toFixed(1)} 秒` : '未收到模型或工具活动'}；${active.firstTextAt ? `首段文本 ${((active.firstTextAt-active.startedAt)/1000).toFixed(1)} 秒` : '未收到回复文本'}。${active.runId ? `\nRun: ${active.runId}` : ''}${event.status === 'failed' ? '\n' + failureText[event.failure ?? 'unknown'] : ''}`)
      this.lastTurnStatus = event.status
      this.lastActivityAt = Date.now()
      this.cancelPending()
      active.task.result = active.stopping || event.status === 'interrupted' ? 'Task stopped.' : event.status === 'failed' ? `${this.agentName} 任务失败。${failureText[event.failure ?? 'unknown']}` : [...active.answers.values()].join('\n\n') || 'Task completed without a text response.'
      this.endActive(event.status)
      this.active = undefined
      try {
        await this.store.save()
        if (this.connected) void this.deliver(active.task, active.channel).catch(() => this.record('send-failed',active.channel,'结果已保存，但回传状态无法落盘；请检查本机存储。'))
      } finally { unpin?.() }
      return
    }
    if (active.stopping || !this.connected) return
    if (event.type === 'progress') {
      const labels = {'run-created':'SDK 已创建运行，等待模型活动','model-active':'模型开始返回活动',generating:'正在生成回复','tool-running':'正在执行工具','tool-completed':'工具执行完成，等待后续活动','tool-failed':'工具报告错误'}
      if (event.runId) active.runId = event.runId
      if (event.phase !== 'run-created') active.firstActivityAt ??= Date.now()
      if (event.phase === 'generating' && this.route.backend !== 'codex') active.firstTextAt ??= Date.now()
      const label = labels[event.phase] + (event.detail ? `（${event.detail}）` : '')
      this.progress(active, label)
      this.record(event.phase, active.channel, `${label} · 已用 ${this.duration(active.startedAt)}`, event.itemId)
      return
    }
    if (event.type === 'preview') {
      active.firstActivityAt ??= Date.now(); active.firstTextAt ??= Date.now()
      const prior = this.activity.findIndex(entry => entry.stage === 'preview' && entry.messageId === active.channel.id && entry.itemId === event.id)
      if (prior >= 0) this.activity.splice(prior,1)
      this.record('preview', active.channel, event.text, event.id)
      this.persistHistory()
      return
    }
    if (event.type === 'commentary') { this.record('commentary',active.channel,event.text,event.id); return }
    if (event.type === 'changes') { this.record('changes', active.channel); active.changes.set(event.id, event.changes) }
    if (event.type === 'message') {
      if (event.text) { active.firstActivityAt ??= Date.now(); active.firstTextAt ??= Date.now() }
      const prior = this.activity.at(-1)
      if (prior?.stage === 'response' && prior.messageId === active.channel.id && prior.itemId === event.id) this.activity.pop()
      this.record('response', active.channel, event.text); this.activity.at(-1)!.itemId = event.id; active.answers.set(event.id, event.text); this.persistHistory()
    }
  }

  private async serverRequest(request: BackendRequest): Promise<unknown> {
    const params: ObjectValue = { ...request.payload, threadId: request.sessionId, turnId: request.turnId }
    const method = ({ tool: 'item/tool/call', command: 'item/commandExecution/requestApproval', file: 'item/fileChange/requestApproval', approval: 'bridge/requestApproval', question: 'item/tool/requestUserInput' } as const)[request.kind]
    // Events and requests arrive on the same stream, but notifications are processed asynchronously.
    await this.events
    const active = this.owns(params)
    if (!active || active.stopping || !this.connected || this.closed) throw new Error('Unowned request')
    active.firstActivityAt ??= Date.now()
    this.progress(active, '正在处理工具请求')
    this.record('request', active.channel, `Agent 请求：${request.kind}`)
    if (method === 'item/tool/call') {
      const tool = params.tool
      if (tool === 'ask_imessage_user') {
        const args = object(params.arguments)
        if (typeof args.question !== 'string' || !args.question.trim() || Object.keys(args).length !== 1) throw new Error('Invalid question')
        const result = await this.serverRequest({ ...request, kind: 'question', payload: { questions: [{ id: 'answer', question: args.question }] } })
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] }
      }
      if (tool !== 'send_imessage_file' && tool !== 'send_imessage_voice') throw new Error('Unknown tool')
      const args = object(params.arguments)
      if (typeof args.path !== 'string' || Object.keys(args).some(key => key !== 'path')) throw new Error('Invalid media path')
      try {
        const media = await loadOutboundMedia({ rawPath: args.path, kind: tool.endsWith('voice') ? 'audio' : 'file', workspaceCwd: this.route.cwd, maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, signal: active.abort.signal })
        if (this.active !== active || active.stopping || !this.connected || active.abort.signal.aborted) throw new Error('Cancelled')
        this.record('sending', active.channel, `附件：${media.name}`)
        if (tool.endsWith('voice')) await active.channel.sendVoice(media)
        else await active.channel.sendFile(media)
        this.record('sent', active.channel)
        return { success: true, contentItems: [{ type: 'inputText', text: `Sent ${media.name}` }] }
      } catch {
        this.record('media-failed', active.channel, '附件读取或发送失败。')
        return { success: false, contentItems: [{ type: 'inputText', text: 'Media could not be sent. Verify that it is a regular file inside the workspace, within 20 MiB, and that this channel turn is still active.' }] }
      }
    }
    const approval = method === 'bridge/requestApproval' || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
    const question = method === 'item/tool/requestUserInput'
    if (approval && this.route.approvalPolicy === 'deny') return {decision:'decline'}
    if (!approval && !question) throw new Error('Unsupported request; fail closed')
    const questions = question && Array.isArray(params.questions) ? params.questions.map(object) : []
    if (question && (!questions.length || questions.some(q => typeof q.id !== 'string' || typeof q.question !== 'string' || q.isSecret === true))) throw new Error('Unsupported question')
    // Never offer broad permission grants, session-wide approval, or a truncated command for approval.
    if (approval && params.grantRoot != null) throw new Error('Session-wide root grants require local review')
    if (method === 'item/commandExecution/requestApproval' && params.kind != null && params.kind !== 'command') throw new Error('Unsupported approval kind')
    const changes = active.changes.get(String(params.itemId))
    if (method === 'item/fileChange/requestApproval' && !changes) throw new Error('File changes unavailable for review')
    const details = method === 'bridge/requestApproval'
      ? JSON.stringify(params.details)
      : approval
        ? JSON.stringify({ method, command: params.command, cwd: params.cwd, reason: params.reason, grantRoot: params.grantRoot, network: params.networkApprovalContext, additionalPermissions: params.additionalPermissions, changes })
        : questions.map(q => `${q.id}: ${q.question}\n${JSON.stringify(q.options ?? [])}`).join('\n')
    if (details.length > 2600) throw new Error('Request too large for safe review over the channel')
    if (approval && Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) throw new Error('Single-action approval unavailable')
    const id = requestId(this.pending)
    this.progress(active, approval ? '等待你的审批' : '等待你的回答')
    this.record(approval ? 'waiting-approval' : 'waiting-answer', active.channel)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value: unknown) => { if (settled) return; settled = true; this.record('interaction-resolved', active.channel); clearTimeout(timer); this.pending.delete(id); this.progress(active, '等待后端继续执行'); resolve(value) }
      const cancel = () => { if (settled) return; settled = true; this.record('interaction-cancelled', active.channel); clearTimeout(timer); this.pending.delete(id); if (approval) resolve({ decision: 'cancel' }); else reject(new Error('Question cancelled')) }
      const timer = setTimeout(cancel, this.interactionTimeoutMs)
      this.pending.set(id, { presentation:interactionPresentation(this.agentName,method,params,changes), details, expiresAt:Date.now() + this.interactionTimeoutMs, kind: approval ? 'approval' : 'question', resolve: finish, cancel, questions: questions.map(q => String(q.id)) })
      const hint = approval ? `/approve ${id} or /deny ${id}` : `/answer ${id} {"question-id":"answer"}`
      void this.send(active.channel, `${approval ? 'Approval requested' : 'Input requested'}\n${details}\n${hint}\nExpires in ${Math.ceil(this.interactionTimeoutMs / 60000)} minutes.`, true).catch(cancel)
    })
  }

  private async answer(channel: ChannelMessage, command: string, args: string[]): Promise<void> {
    const request = this.pending.get(args[0] ?? '')
    if (!request || !this.active || this.active.stopping) { await this.send(channel, 'Request expired or does not belong to this route.'); return }
    if (request.kind === 'approval' && (command === '/approve' || command === '/deny') && args.length === 1) {
      request.resolve({ decision: command === '/approve' ? 'accept' : 'decline' })
    } else if (request.kind === 'question' && command === '/answer') {
      try {
        const data = object(JSON.parse(args.slice(1).join(' ')))
        if (Object.keys(data).length !== request.questions.length || request.questions.some(id => typeof data[id] !== 'string' || !(data[id] as string).trim())) throw new Error('Invalid answers')
        request.resolve({ answers: Object.fromEntries(request.questions.map(id => [id, { answers: [data[id]] }])) })
      } catch { await this.send(channel, 'Reply with a JSON object containing one text answer for every question id.'); return }
    } else { await this.send(channel, 'That command does not match the pending request.'); return }
    await this.send(channel, `Response delivered to ${this.agentName}.`)
  }

  private endActive(status: TaskRecord['execution'], release = true): void {
    if (!this.active) return
    this.active.task.execution = status
    this.active.task.finishedAt = Date.now()
    this.active.abort.abort(); if (release) this.active.release()
    void this.store.save().catch(() => {})
  }
  deliver(task: TaskRecord, channel: ChannelMessage): Promise<void> {
    const unpin=this.store.pinTask?.(task.id)
    const work = this.deliverResult(task,channel)
    this.deliveries.add(work)
    void work.then(() => {this.deliveries.delete(work);unpin?.()}, () => {this.deliveries.delete(work);unpin?.()})
    return work
  }
  private async deliverResult(task: TaskRecord, channel: ChannelMessage): Promise<void> {
    if (!task.result || task.delivery === 'sending' || task.delivery === 'sent') throw new PluginError('invalid-command','结果尚未生成、正在发送或已发送。')
    task.delivery = 'sending'
    await this.store.save()
    try { await this.send(channel, task.result); task.delivery = 'sent' }
    catch { task.delivery = 'uncertain' }
    await this.store.save()
  }
  async control(taskId: string, action: string, requestId?: string, answers?: Record<string,string>): Promise<void> {
    const active = this.active
    if (!active || active.task.id !== taskId || active.stopping) throw new PluginError('request-not-found','任务已结束或已请求停止，请刷新后重试。')
    if (action === 'stop') {
      active.stopping = true; active.abort.abort(); this.cancelPending()
      if (active.turnId) await this.backend.cancel(active.sessionId!,active.turnId)
      return
    }
    const pending = this.pending.get(requestId ?? '')
    if (!pending || pending.expiresAt <= Date.now()) throw new PluginError('request-not-found','请求已过期或已在另一端处理。')
    if (pending.kind === 'approval' && ['approve','deny'].includes(action)) pending.resolve({decision:action === 'approve' ? 'accept' : 'decline'})
    else if (pending.kind === 'question' && action === 'answer' && answers && Object.keys(answers).length === pending.questions.length && pending.questions.every(id => typeof answers[id] === 'string' && answers[id]!.trim())) pending.resolve({answers:Object.fromEntries(pending.questions.map(id => [id,{answers:[answers[id]]}]))})
    else throw new PluginError('invalid-command','请为每个问题提供回答。')
  }
  private cancelPending(): void { for (const entry of [...this.pending.values()]) entry.cancel() }
  private send(channel: ChannelMessage, text: string, raw = false, guard: () => boolean = () => true): Promise<void> {
    const work = this.outgoing.then(async () => { if (guard()) await this.sendNow(channel, text, raw) })
    this.outgoing = work.catch(() => {})
    return work
  }
  private async sendNow(channel: ChannelMessage, text: string, raw: boolean): Promise<void> {
    const startedAt = Date.now()
    this.record('sending', channel, text)
    try {
      for (const part of chunkText(raw ? text : markdownToPlainText(text), 3500)) await channel.send(part)
      this.record('sent', channel, `发送耗时 ${this.duration(startedAt)}`)
    } catch (error) {
      this.record('send-failed', channel, '渠道发送失败；分段消息可能已有部分发出。')
      throw error
    }
  }
}

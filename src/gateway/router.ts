import { gatewayTools as tools } from './tools.js'
import { randomUUID } from 'node:crypto'
import { chunkText } from '../chunks.js'
import { markdownToPlainText } from '../plaintext.js'
import { loadOutboundMedia, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../media.js'
import type { SpectrumInboundMessage } from '../spectrum-runtime.js'
import type { RouteConfig } from './config.js'
import { object, SessionInUseError, type ObjectValue } from '../backends/jsonrpc.js'
import type { Backend, BackendEvent, BackendRequest } from '../backends/types.js'
import type { RouteState } from './state.js'

interface Store { state: RouteState; save(): Promise<void> }
interface Active {
  channel: SpectrumInboundMessage
  turnId?: string
  stopping: boolean
  abort: AbortController
  answers: Map<string, string>
  changes: Map<string, unknown>
}
interface Pending {
  kind: 'approval' | 'question'
  resolve(value: unknown): void
  cancel(): void
  questions: string[]
}


/** One route owns one thread and at most one turn. Busy prompts are rejected, never silently queued. */
export class GatewayRouter {
  private active: Active | undefined
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

  constructor(private readonly backend: Backend, private readonly route: RouteConfig, private readonly store: Store, private readonly interactionTimeoutMs = 600_000) {
    backend.onEvent = event => {
      this.events = this.events.then(() => this.notification(event)).catch(() => this.fail())
    }
    backend.onRequest = request => this.serverRequest(request)
    backend.onClose = () => { this.closed = true; this.cancelPending(); this.active?.abort.abort(); this.active = undefined }
  }

  private get agentName(): string { return this.route.backend === 'cursor' ? 'Cursor' : this.route.backend === 'dsh' ? 'DSH' : 'Codex' }

  snapshot() { return { busy: Boolean(this.active), sessionId: this.store.state.threadId, pending: this.pending.size, closed: this.closed, receivedCount: this.receivedCount, lastActivityAt: this.lastActivityAt, lastTurnStatus: this.lastTurnStatus } }

  setConnected(value: boolean): void {
    this.connected = value
    if (!value && this.active) {
      this.active.stopping = true
      this.active.abort.abort()
      this.cancelPending()
      const turnId = this.active.turnId
      if (turnId) void this.backend.cancel(this.store.state.threadId!, turnId).catch(() => this.fail())
    }
  }

  receive(channel: SpectrumInboundMessage): Promise<void> {
    const operation = this.incoming.then(async () => {
      if (this.closed || !this.connected || this.store.state.seen.includes(channel.id)) return
      this.store.state.seen.push(channel.id)
      this.store.state.seen = this.store.state.seen.slice(-1024)
      await this.store.save()
      this.receivedCount++
      this.lastActivityAt = Date.now()
      await this.handle(channel)
    })
    this.incoming = operation.catch(async error => {
      if (error instanceof SessionInUseError && !this.active) {
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

  async close(): Promise<void> { this.fail(); await this.closing }

  private fail(): void {
    this.closed = true
    this.cancelPending()
    this.active?.abort.abort()
    this.active = undefined
    this.closing ??= this.backend.close().catch(() => {})
  }

  private async handle(channel: SpectrumInboundMessage): Promise<void> {
    const text = channel.text.trim()
    if (!text) return
    const [command, ...args] = text.split(/\s+/)
    if (command === '/help') {
      await this.send(channel, 'Send a task as text. /new starts a fresh thread; /sessions lists this route’s sessions; /switch ID resumes one; /status shows this route; /stop interrupts; /approve ID or /deny ID answers an approval; /answer ID {"question-id":"answer"} answers questions. Use // for a prompt starting with /.')
      return
    }
    if (command === '/status') {
      await this.send(channel, `Route: ${this.route.id}\nAgent: ${this.agentName}\nThread: ${this.store.state.threadId ?? 'not started'}\nState: ${this.active ? (this.active.stopping ? 'stopping' : 'running') : 'idle'}\nPending questions/approvals: ${this.pending.size}`)
      return
    }
    if (command === '/stop' || command === '/cancel') {
      const active = this.active
      if (!active) { await this.send(channel, 'No active turn.'); return }
      active.stopping = true
      active.abort.abort()
      this.cancelPending()
      if (active.turnId) await this.backend.cancel(this.store.state.threadId!, active.turnId)
      await this.send(channel, `Stop requested. Waiting for ${this.agentName} to finish interrupting.`)
      return
    }
    if (command === '/approve' || command === '/deny' || command === '/answer') {
      await this.answer(channel, command, args)
      return
    }
    if (this.active) { await this.send(channel, 'A task is already running. Use /stop before starting another.'); return }
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
    if (text.startsWith('/') && !text.startsWith('//')) { await this.send(channel, 'Unknown command. Send /help.'); return }
    await this.ensureThread()
    const active: Active = { channel, stopping: false, abort: new AbortController(), answers: new Map(), changes: new Map() }
    this.active = active
    void channel.responding(() => new Promise<void>(resolve => {
      if (active.abort.signal.aborted) resolve()
      else active.abort.signal.addEventListener('abort', () => resolve(), { once: true })
    })).catch(() => {})
    const id = await this.backend.startTurn(this.store.state.threadId!, text.startsWith('//') ? text.slice(1) : text)
    if (this.active !== active) return
    if (active.turnId && active.turnId !== id) throw new Error('Turn ownership mismatch')
    active.turnId = id
    if (active.stopping || !this.connected) await this.backend.cancel(this.store.state.threadId!, id)
  }

  private async ensureThread(): Promise<void> {
    if (this.ready) return
    const threadId = this.store.state.threadId
    const thread = await this.backend.openSession({
      ...(threadId ? { id: threadId } : {}), tools, cwd: this.route.cwd,
      ...(this.route.approvalPolicy ? {approvalPolicy:this.route.approvalPolicy} : {}),
      ...(this.route.model ? { model: this.route.model } : {}),
      ...(this.route.speed && this.route.speed !== 'default' ? {speed:this.route.speed} : {}),
      ...(this.route.effort && this.route.effort !== 'default' ? { effort: this.route.effort } : {}),
    })
    if (typeof thread.id !== 'string' || thread.cwd !== this.route.cwd || (threadId && thread.id !== threadId)) throw new Error('Thread workspace mismatch')
    this.store.state.threadId = thread.id
    this.store.state.sessions = [...new Set([...(this.store.state.sessions ?? []), thread.id])].slice(-100)
    await this.store.save()
    this.ready = true
  }

  private owns(params: ObjectValue): Active | undefined {
    const active = this.active
    if (!active || !active.turnId || params.threadId !== this.store.state.threadId || params.turnId !== active.turnId) return undefined
    return active
  }

  private async notification(event: BackendEvent): Promise<void> {
    if (event.type === 'started' && this.active && event.sessionId === this.store.state.threadId) {
      if (this.active.turnId && this.active.turnId !== event.turnId) { this.fail(); return }
      this.active.turnId = event.turnId
      return
    }
    const active = this.owns({ threadId: event.sessionId, turnId: event.turnId })
    if (!active) return
    if (event.type === 'completed') {
      this.lastTurnStatus = event.status
      this.lastActivityAt = Date.now()
      this.cancelPending()
      active.abort.abort()
      this.active = undefined
      if (!this.connected) return
      if (active.stopping || event.status === 'interrupted') await this.send(active.channel, 'Task stopped.')
      else if (event.status === 'failed') await this.send(active.channel, event.failure === 'session-busy'
        ? `${this.agentName} session is blocked by an existing run. Send /new to start a separate session, or recover the existing run locally.`
        : event.failure === 'authentication'
          ? `${this.agentName} authentication failed. Check the configured API key.`
          : `${this.agentName} could not complete the task. The backend did not provide a recognized failure reason.`)
      else await this.send(active.channel, [...active.answers.values()].join('\n\n') || 'Task completed without a text response.')
      return
    }
    if (active.stopping || !this.connected) return
    if (event.type === 'changes') active.changes.set(event.id, event.changes)
    if (event.type === 'message') active.answers.set(event.id, event.text)
  }

  private async serverRequest(request: BackendRequest): Promise<unknown> {
    const params: ObjectValue = { ...request.payload, threadId: request.sessionId, turnId: request.turnId }
    const method = ({ tool: 'item/tool/call', command: 'item/commandExecution/requestApproval', file: 'item/fileChange/requestApproval', approval: 'bridge/requestApproval', question: 'item/tool/requestUserInput' } as const)[request.kind]
    // Events and requests arrive on the same stream, but notifications are processed asynchronously.
    await this.events
    const active = this.owns(params)
    if (!active || active.stopping || !this.connected || this.closed) throw new Error('Unowned request')
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
        if (tool.endsWith('voice')) await active.channel.sendVoice(media)
        else await active.channel.sendFile(media)
        return { success: true, contentItems: [{ type: 'inputText', text: `Sent ${media.name}` }] }
      } catch {
        return { success: false, contentItems: [{ type: 'inputText', text: 'Media could not be sent. Verify that it is a regular file inside the workspace, within 20 MiB, and that this iMessage turn is still active.' }] }
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
    if (details.length > 2600) throw new Error('Request too large for safe review over iMessage')
    if (approval && Array.isArray(params.availableDecisions) && !params.availableDecisions.includes('accept')) throw new Error('Single-action approval unavailable')
    const id = randomUUID().slice(0, 8)
    return new Promise((resolve, reject) => {
      const finish = (value: unknown) => { clearTimeout(timer); this.pending.delete(id); resolve(value) }
      const cancel = () => { clearTimeout(timer); this.pending.delete(id); if (approval) resolve({ decision: 'cancel' }); else reject(new Error('Question cancelled')) }
      const timer = setTimeout(cancel, this.interactionTimeoutMs)
      this.pending.set(id, { kind: approval ? 'approval' : 'question', resolve: finish, cancel, questions: questions.map(q => String(q.id)) })
      const hint = approval ? `/approve ${id} or /deny ${id}` : `/answer ${id} {"question-id":"answer"}`
      void this.send(active.channel, `${approval ? 'Approval requested' : 'Input requested'}\n${details}\n${hint}\nExpires in ${Math.ceil(this.interactionTimeoutMs / 60000)} minutes.`, true).catch(cancel)
    })
  }

  private async answer(channel: SpectrumInboundMessage, command: string, args: string[]): Promise<void> {
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

  private cancelPending(): void { for (const entry of [...this.pending.values()]) entry.cancel() }
  private async send(channel: SpectrumInboundMessage, text: string, raw = false): Promise<void> {
    for (const part of chunkText(raw ? text : markdownToPlainText(text), 3500)) await channel.send(part)
  }
}

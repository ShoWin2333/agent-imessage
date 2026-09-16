import { randomUUID } from 'node:crypto'
import { chunkText } from '../chunks.js'
import { markdownToPlainText } from '../plaintext.js'
import { loadOutboundMedia, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../media.js'
import type { SpectrumInboundMessage } from '../spectrum-runtime.js'
import type { RouteConfig } from './config.js'
import { object, type ObjectValue, type Rpc } from './rpc.js'
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

const tools = ['send_imessage_file', 'send_imessage_voice'].map(name => ({
  type: 'function', name, deferLoading: false,
  description: `Send an existing ${name.endsWith('voice') ? 'audio file as native voice' : 'file or image'} from the current workspace to the initiating iMessage conversation. Only use when requested by the user.`,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
}))

/** One route owns one thread and at most one turn. Busy prompts are rejected, never silently queued. */
export class CodexRouter {
  private active: Active | undefined
  private ready = false
  private connected = false
  private closed = false
  private readonly pending = new Map<string, Pending>()
  private incoming: Promise<void> = Promise.resolve()
  private events: Promise<void> = Promise.resolve()

  constructor(private readonly rpc: Rpc, private readonly route: RouteConfig, private readonly store: Store, private readonly interactionTimeoutMs = 600_000) {
    rpc.onNotification = (method, params) => {
      this.events = this.events.then(() => this.notification(method, params)).catch(() => this.fail())
    }
    rpc.onRequest = (method, params) => this.serverRequest(method, params)
    rpc.onClose = () => { this.closed = true; this.cancelPending(); this.active?.abort.abort(); this.active = undefined }
  }

  private get agentName(): string { return this.route.backend === 'cursor' ? 'Cursor' : 'Codex' }

  setConnected(value: boolean): void {
    this.connected = value
    if (!value && this.active) {
      this.active.stopping = true
      this.active.abort.abort()
      this.cancelPending()
      const turnId = this.active.turnId
      if (turnId) void this.rpc.request('turn/interrupt', { threadId: this.store.state.threadId, turnId }).catch(() => this.fail())
    }
  }

  receive(channel: SpectrumInboundMessage): Promise<void> {
    const operation = this.incoming.then(async () => {
      if (this.closed || !this.connected || this.store.state.seen.includes(channel.id)) return
      this.store.state.seen.push(channel.id)
      this.store.state.seen = this.store.state.seen.slice(-1024)
      await this.store.save()
      await this.handle(channel)
    })
    this.incoming = operation.catch(async () => {
      // Do not expose upstream errors, prompts or credentials to the remote channel.
      this.fail()
      await this.send(channel, 'Bridge stopped after an error. Check the local process and restart it; this message will not be replayed automatically.').catch(() => {})
    })
    return this.incoming
  }

  close(): void { this.fail() }

  private fail(): void {
    this.closed = true
    this.cancelPending()
    this.active?.abort.abort()
    this.active = undefined
    this.rpc.close()
  }

  private async handle(channel: SpectrumInboundMessage): Promise<void> {
    const text = channel.text.trim()
    if (!text) return
    const [command, ...args] = text.split(/\s+/)
    if (command === '/help') {
      await this.send(channel, 'Send a task as text. /new starts a fresh thread; /status shows this route; /stop interrupts; /approve ID or /deny ID answers an approval; /answer ID {"question-id":"answer"} answers questions. Use // for a prompt starting with /.')
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
      if (active.turnId) await this.rpc.request('turn/interrupt', { threadId: this.store.state.threadId, turnId: active.turnId })
      await this.send(channel, `Stop requested. Waiting for ${this.agentName} to finish interrupting.`)
      return
    }
    if (command === '/approve' || command === '/deny' || command === '/answer') {
      await this.answer(channel, command, args)
      return
    }
    if (this.active) { await this.send(channel, 'A task is already running. Use /stop before starting another.'); return }
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
    const response = await this.rpc.request('turn/start', {
      threadId: this.store.state.threadId,
      input: [{ type: 'text', text: text.startsWith('//') ? text.slice(1) : text }],
    })
    const id = object(response.turn).id
    if (typeof id !== 'string') throw new Error('Invalid turn response')
    if (this.active !== active) return
    if (active.turnId && active.turnId !== id) throw new Error('Turn ownership mismatch')
    active.turnId = id
    if (active.stopping || !this.connected) await this.rpc.request('turn/interrupt', { threadId: this.store.state.threadId, turnId: id })
    else await this.send(channel, `${this.agentName} has started your task.`)
  }

  private async ensureThread(): Promise<void> {
    if (this.ready) return
    const threadId = this.store.state.threadId
    const response = await this.rpc.request(threadId ? 'thread/resume' : 'thread/start', {
      ...(threadId ? { threadId } : { dynamicTools: this.route.backend === 'cursor' ? [] : tools }),
      cwd: this.route.cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      ...(this.route.model ? { model: this.route.model } : {}),
    })
    const thread = object(response.thread)
    if (typeof thread.id !== 'string' || thread.cwd !== this.route.cwd || (threadId && thread.id !== threadId)) throw new Error('Thread workspace mismatch')
    this.store.state.threadId = thread.id
    await this.store.save()
    this.ready = true
  }

  private owns(params: ObjectValue): Active | undefined {
    const active = this.active
    if (!active || !active.turnId || params.threadId !== this.store.state.threadId || params.turnId !== active.turnId) return undefined
    return active
  }

  private async notification(method: string, params: ObjectValue): Promise<void> {
    if (method === 'turn/started' && this.active && params.threadId === this.store.state.threadId) {
      const id = object(params.turn).id
      if (typeof id === 'string') {
        if (this.active.turnId && this.active.turnId !== id) { this.fail(); return }
        this.active.turnId = id
      }
      return
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn)
      const active = this.owns({ ...params, turnId: turn.id })
      if (!active) return
      this.cancelPending()
      active.abort.abort()
      this.active = undefined
      if (!this.connected) return
      if (active.stopping || turn.status === 'interrupted') await this.send(active.channel, 'Task stopped.')
      else if (turn.status === 'failed') await this.send(active.channel, `${this.agentName} could not complete the task. Check the local account and configuration.`)
      else await this.send(active.channel, [...active.answers.values()].join('\n\n') || 'Task completed without a text response.')
      return
    }
    const active = this.owns(params)
    if (!active || active.stopping || !this.connected) return
    if (method === 'item/started') {
      const item = object(params.item)
      if (item.type === 'fileChange' && typeof item.id === 'string') active.changes.set(item.id, item.changes)
    }
    if (method === 'item/completed') {
      const item = object(params.item)
      if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null) && typeof item.text === 'string' && typeof item.id === 'string') active.answers.set(item.id, item.text)
    }
  }

  private async serverRequest(method: string, params: ObjectValue): Promise<unknown> {
    // Events and requests arrive on the same stream, but notifications are processed asynchronously.
    await this.events
    const active = this.owns(params)
    if (!active || active.stopping || !this.connected || this.closed) throw new Error('Unowned request')
    if (method === 'item/tool/call') {
      if (this.route.backend === 'cursor') throw new Error('Cursor media tools are unavailable')
      const tool = params.tool
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
    if (method === 'bridge/requestApproval' && this.route.backend !== 'cursor') throw new Error('Unsupported approval source')
    const approval = method === 'bridge/requestApproval' || method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
    const question = method === 'item/tool/requestUserInput'
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

import { randomUUID } from 'node:crypto'
import { JsonRpcProcess, object, type ObjectValue, type Rpc } from '../codex/rpc.js'
import type { RouteConfig } from '../codex/config.js'

interface AcpConnection extends Rpc {
  notify(method: string, params: ObjectValue): void
  request(method: string, params: ObjectValue, timeoutMs?: number): Promise<ObjectValue>
}
interface Turn { id: string; text: string; cancelled: boolean }

/** Translate ACP into the existing route lifecycle; the backend never receives Photon credentials. */
export class CursorServer implements Rpc {
  onNotification: Rpc['onNotification'] = () => {}
  onRequest: Rpc['onRequest'] = async () => { throw new Error('Unsupported request') }
  onClose = () => {}
  private sessionId: string | undefined
  private active: Turn | undefined
  private loadSession = false
  private closed = false
  private cancelTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly wire: AcpConnection, private readonly route: RouteConfig) {
    wire.onNotification = (method, params) => this.notification(method, params)
    wire.onRequest = (method, params) => this.serverRequest(method, params)
    wire.onClose = () => { clearTimeout(this.cancelTimer); this.closed = true; this.active = undefined; this.onClose() }
  }

  static spawn(binary: string, route: RouteConfig, secretNames: string[]): CursorServer {
    const args = [...(route.model ? ['--model', route.model] : []), 'acp']
    return new CursorServer(new JsonRpcProcess(binary, route.cwd, secretNames, { args, jsonrpc: true }), route)
  }

  async initialize(): Promise<void> {
    const init = await this.wire.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-imessage', version: '0.1.0' },
    })
    if (init.protocolVersion !== 1) throw new Error('Unsupported ACP version')
    this.loadSession = object(init.agentCapabilities).loadSession === true
    await this.wire.request('authenticate', { methodId: 'cursor_login' })
  }

  close(): void { clearTimeout(this.cancelTimer); this.closed = true; this.active = undefined; this.wire.close() }

  async request(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (this.closed) throw new Error('Cursor connection closed')
    if (method === 'thread/start' || method === 'thread/resume') {
      if (this.active || params.cwd !== this.route.cwd) throw new Error('Invalid session scope')
      const resume = method === 'thread/resume'
      if (resume && (!this.loadSession || typeof params.threadId !== 'string')) throw new Error('Cursor session resume unavailable')
      this.sessionId = undefined // Ignore replayed history during session/load.
      const result = await this.wire.request(resume ? 'session/load' : 'session/new', {
        cwd: this.route.cwd, mcpServers: [], ...(resume ? { sessionId: params.threadId } : {}),
      })
      const sessionId = resume ? params.threadId : result.sessionId
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid ACP session')
      const mode = this.route.cursorMode ?? 'agent'
      const modes = object(result.modes)
      if (!Array.isArray(modes.availableModes) || !modes.availableModes.some(m => object(m).id === mode)) throw new Error('Requested Cursor mode unavailable')
      if (modes.currentModeId !== mode) await this.wire.request('session/set_mode', { sessionId, modeId: mode })
      this.sessionId = sessionId
      return { thread: { id: sessionId, cwd: this.route.cwd } }
    }
    if (!this.sessionId || params.threadId !== this.sessionId) throw new Error('Unowned session')
    if (method === 'turn/start') {
      if (this.active || !Array.isArray(params.input)) throw new Error('Invalid prompt')
      const prompt = params.input.map(object)
      if (!prompt.length || prompt.some(p => p.type !== 'text' || typeof p.text !== 'string')) throw new Error('Text prompts only')
      const turn: Turn = { id: randomUUID(), text: '', cancelled: false }
      this.active = turn
      this.onNotification('turn/started', { threadId: this.sessionId, turn: { id: turn.id } })
      // ACP prompt resolves at completion, whereas the route expects a start acknowledgment.
      void this.wire.request('session/prompt', { sessionId: this.sessionId, prompt }, 30 * 60_000).then(
        result => this.complete(turn, result.stopReason === 'cancelled' || turn.cancelled ? 'interrupted' : result.stopReason === 'end_turn' ? 'completed' : 'failed'),
        () => this.complete(turn, turn.cancelled ? 'interrupted' : 'failed'),
      )
      return { turn: { id: turn.id } }
    }
    if (method === 'turn/interrupt') {
      if (this.active && !this.active.cancelled && params.turnId === this.active.id) {
        this.active.cancelled = true
        this.wire.notify('session/cancel', { sessionId: this.sessionId })
        this.cancelTimer = setTimeout(() => this.close(), 10_000)
      }
      return {}
    }
    throw new Error('Unsupported Cursor operation')
  }

  private complete(turn: Turn, status: string): void {
    if (this.closed || this.active !== turn) return
    clearTimeout(this.cancelTimer)
    this.onNotification('item/completed', { threadId: this.sessionId, turnId: turn.id, item: { id: turn.id, type: 'agentMessage', phase: 'final_answer', text: turn.text } })
    this.active = undefined
    this.onNotification('turn/completed', { threadId: this.sessionId, turn: { id: turn.id, status } })
  }

  private notification(method: string, params: ObjectValue): void {
    if (method !== 'session/update' || params.sessionId !== this.sessionId || !this.active || this.active.cancelled) return
    const update = object(params.update)
    const content = object(update.content)
    if (update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string') {
      this.active.text += content.text
      if (this.active.text.length > 1_000_000) this.close()
    }
  }

  private async serverRequest(method: string, params: ObjectValue): Promise<unknown> {
    const turn = this.active
    if (!turn || turn.cancelled || this.closed || (params.sessionId !== undefined && params.sessionId !== this.sessionId)) throw new Error('Unowned Cursor request')
    const owned = { threadId: this.sessionId, turnId: turn.id }
    if (method === 'session/request_permission') {
      if (params.sessionId !== this.sessionId) throw new Error('Missing session ownership')
      const options = Array.isArray(params.options) ? params.options.map(object) : []
      const allow = options.find(o => o.kind === 'allow_once' && typeof o.optionId === 'string')
      const deny = options.find(o => o.kind === 'reject_once' && typeof o.optionId === 'string')
      const tool = object(params.toolCall)
      if (!allow || typeof tool.title !== 'string' || !tool.title.trim() || (!Object.keys(object(tool.rawInput)).length && !(Array.isArray(tool.content) && tool.content.length))) return { outcome: { outcome: 'cancelled' } }
      try {
        const response = object(await this.onRequest('bridge/requestApproval', { ...owned, details: tool }))
        if (this.active !== turn || turn.cancelled || this.closed) return { outcome: { outcome: 'cancelled' } }
        const option = response.decision === 'accept' ? allow : response.decision === 'decline' ? deny : undefined
        return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
      } catch { return { outcome: { outcome: 'cancelled' } } }
    }
    if (method === 'cursor/create_plan') {
      if (typeof params.plan !== 'string' || !params.plan.trim()) return { outcome: { outcome: 'cancelled' } }
      try {
        const response = object(await this.onRequest('bridge/requestApproval', { ...owned, details: params }))
        return { outcome: { outcome: this.active !== turn || turn.cancelled || this.closed ? 'cancelled' : response.decision === 'accept' ? 'accepted' : response.decision === 'decline' ? 'rejected' : 'cancelled' } }
      } catch { return { outcome: { outcome: 'cancelled' } } }
    }
    if (method === 'cursor/ask_question') {
      const questions = Array.isArray(params.questions) ? params.questions.map(object) : []
      if (!questions.length || questions.some(q => typeof q.id !== 'string' || typeof q.prompt !== 'string' || q.allowMultiple === true || !Array.isArray(q.options))) return { outcome: { outcome: 'cancelled' } }
      try {
        const response = object(await this.onRequest('item/tool/requestUserInput', { ...owned, questions: questions.map(q => ({ id: q.id, question: `${q.prompt}\nReply with one option id.`, options: q.options })) }))
        if (this.active !== turn || turn.cancelled || this.closed) throw new Error('Cancelled')
        const values = object(response.answers)
        const answers = questions.map(q => {
          const answer = object(values[String(q.id)]).answers
          const id = Array.isArray(answer) ? answer[0] : undefined
          if (typeof id !== 'string' || !(q.options as unknown[]).some(o => object(o).id === id)) throw new Error('Invalid option')
          return { questionId: q.id, selectedOptionIds: [id] }
        })
        return { outcome: { outcome: 'answered', answers } }
      } catch { return { outcome: { outcome: 'cancelled' } } }
    }
    throw new Error('Unsupported Cursor request')
  }
}

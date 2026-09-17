import { randomUUID } from 'node:crypto'
import { JsonRpcProcess, object, type Rpc, type ObjectValue } from './jsonrpc.js'
import { BaseBackend, type SessionOptions } from './types.js'
import { startToolServer } from './tool-server.js'

interface Wire extends Rpc { waitClosed?(): Promise<void>; notify(method: string, params: ObjectValue): void; request(method: string, params: ObjectValue, timeoutMs?: number): Promise<ObjectValue> }
/** Owns a headless DSH ACP process. No DSH Web or plugin UI is involved. */
export class DshBackend extends BaseBackend {
  private sessionId: string | undefined
  private active: { id: string; text: string; cancelled: boolean } | undefined
  private closed = false
  private toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined
  private cancelTimer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly wire: Wire) {
    super()
    wire.onClose = () => { this.closed = true; clearTimeout(this.cancelTimer); this.onClose() }
    wire.onNotification = (method, params) => {
      if (method !== 'session/update' || params.sessionId !== this.sessionId || !this.active || this.active.cancelled) return
      const update = object(params.update), content = object(update.content)
      if (update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string') {
        this.active.text += content.text
        if (this.active.text.length > 1_000_000) void this.close()
      }
    }
    wire.onRequest = async (method, params) => {
      const active = this.active
      if (method !== 'session/request_permission' || !active || active.cancelled || params.sessionId !== this.sessionId) throw new Error('Unowned request')
      const options = Array.isArray(params.options) ? params.options.map(object) : []
      const allow = options.find(o => o.kind === 'allow_once'), deny = options.find(o => o.kind === 'reject_once')
      const details = object(params.toolCall)
      if (!allow || !details.title) return { outcome: { outcome: 'cancelled' } }
      const answer = object(await this.onRequest({ kind: 'approval', sessionId: this.sessionId!, turnId: active.id, payload: { details } }))
      const option = answer.decision === 'accept' ? allow : answer.decision === 'decline' ? deny : undefined
      return { outcome: option && this.active === active && !active.cancelled ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } }
    }
  }
  static spawn(binary: string, cwd: string, secrets: string[]): DshBackend {
    return new DshBackend(new JsonRpcProcess(binary, cwd, secrets, { args: ['--profile', 'acp'], jsonrpc: true, env: { DSH_PERMISSION_MODE: 'workspace-write' } }))
  }
  async initialize(): Promise<void> {
    const result = await this.wire.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agent-imessage', version: '1.0.0' } })
    if (result.protocolVersion !== 1) throw new Error('Unsupported DSH protocol')
  }
  async openSession(options: SessionOptions): Promise<{ id: string; cwd: string }> {
    if (this.active || this.closed) throw new Error('Invalid session scope')
    if (this.sessionId) await this.wire.request('session/close', { sessionId: this.sessionId })
    this.sessionId = undefined
    await this.toolServer?.close()
    this.toolServer = await startToolServer(options.tools, async (name, args) => {
      const active = this.active
      if (!active || active.cancelled || !this.sessionId || this.closed) throw new Error('No owning turn')
      return this.onRequest({ kind: 'tool', sessionId: this.sessionId, turnId: active.id, payload: { tool: name, arguments: args } })
    })
    const result = await this.wire.request(options.id ? 'session/resume' : 'session/new', {
      cwd: options.cwd, ...(options.id ? { sessionId: options.id } : {}),
      mcpServers: [{ type: 'http', name: 'imessage', url: this.toolServer.url, headers: [{ name: 'Authorization', value: `Bearer ${this.toolServer.token}` }] }],
    })
    const id = options.id ?? result.sessionId
    if (typeof id !== 'string') throw new Error('Invalid DSH session')
    this.sessionId = id
    for (const [key, value] of [['model', options.model], ['reasoning_effort', options.effort]] as const) {
      if (value) await this.wire.request('session/set_config_option', { sessionId: id, configId: key, value })
    }
    return { id, cwd: options.cwd }
  }
  async startTurn(sessionId: string, text: string): Promise<string> {
    if (this.closed || this.active || sessionId !== this.sessionId) throw new Error('Invalid turn')
    const active = { id: randomUUID(), text: '', cancelled: false }
    this.active = active
    this.onEvent({ type: 'started', sessionId, turnId: active.id })
    void this.wire.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 30 * 60_000).then(
      result => this.complete(active, result.stopReason === 'cancelled' ? 'interrupted' : result.stopReason === 'end_turn' ? 'completed' : 'failed'),
      () => this.complete(active, 'failed'),
    )
    return active.id
  }
  private complete(active: NonNullable<typeof this.active>, status: 'completed' | 'interrupted' | 'failed'): void {
    if (this.closed || this.active !== active) return
    clearTimeout(this.cancelTimer)
    const sessionId = this.sessionId!, turnId = active.id
    this.onEvent({ type: 'message', sessionId, turnId, id: turnId, text: active.text })
    this.active = undefined
    this.onEvent({ type: 'completed', sessionId, turnId, status: active.cancelled ? 'interrupted' : status })
  }
  async cancel(sessionId: string, turnId: string): Promise<void> {
    if (this.active?.id !== turnId || sessionId !== this.sessionId) return
    this.active.cancelled = true
    this.wire.notify('session/cancel', { sessionId })
    this.cancelTimer = setTimeout(() => { void this.close() }, 10_000)
  }
  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.cancelTimer)
    this.wire.close()
    await this.toolServer?.close()
    await this.wire.waitClosed?.()
  }
}

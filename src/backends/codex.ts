import { toolCategory } from './progress.js'
import { backendFailure } from './failure.js'
import { JsonRpcProcess, object, type Rpc } from './jsonrpc.js'
import { BaseBackend, type BackendRequest, type SessionOptions } from './types.js'

/** Codex App Server protocol translation; lifecycle belongs to Gateway. */
export class CodexBackend extends BaseBackend {
  private readonly previews = new Map<string,string>()
  private readonly previewTimes = new Map<string,number>()
  constructor(private readonly rpc: Rpc & { initialize?: () => Promise<void>; waitClosed?: () => Promise<void> }) {
    super()
    rpc.onClose = () => this.onClose()
    rpc.onNotification = (method, params) => {
      const sessionId = String(params.threadId ?? '')
      const turn = object(params.turn)
      const turnId = String(params.turnId ?? turn.id ?? '')
      if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        const id = String(params.itemId ?? ''), key = `${sessionId}:${turnId}:${id}`
        const text = ((this.previews.get(key) ?? '') + params.delta).slice(-8000)
        this.previews.set(key,text)
        if (Date.now() - (this.previewTimes.get(key) ?? 0) >= 500) {
          this.previewTimes.set(key,Date.now())
          this.onEvent({type:'preview',sessionId,turnId,id,text})
        }
      }
      if (method === 'turn/completed') { this.previews.clear(); this.previewTimes.clear() }
      if (method === 'turn/started') this.onEvent({ type: 'started', sessionId, turnId })
      if (method === 'turn/completed') this.onEvent({ type: 'completed', sessionId, turnId, status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed', ...(turn.status === 'failed' ? {failure:backendFailure(turn.error)} : {}) })
      const item = object(params.item)
      if (method === 'item/started') {
        const phase = item.type === 'agentMessage' ? 'generating' : item.type === 'reasoning' ? 'model-active' : ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch'].includes(String(item.type)) ? 'tool-running' : undefined
        if (phase) this.onEvent({type:'progress',sessionId,turnId,itemId:String(item.id),phase,...(phase === 'tool-running' ? {detail:toolCategory(item.type)} : {})})
      }
      if (method === 'item/completed' && ['commandExecution','mcpToolCall','dynamicToolCall'].includes(String(item.type))) this.onEvent({type:'progress',sessionId,turnId,itemId:String(item.id),phase:item.status === 'failed' ? 'tool-failed' : 'tool-completed'})
      if (method === 'item/started' && item.type === 'fileChange') this.onEvent({ type: 'changes', sessionId, turnId, id: String(item.id), changes: item.changes })
      if (method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'commentary' && typeof item.text === 'string') this.onEvent({type:'commentary',sessionId,turnId,id:String(item.id),text:item.text})
      if (method === 'item/completed' && item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null) && typeof item.text === 'string') this.onEvent({ type: 'message', sessionId, turnId, id: String(item.id), text: item.text })
    }
    rpc.onRequest = async (method, payload) => {
      const kinds: Record<string, BackendRequest['kind']> = {
        'item/tool/call': 'tool', 'item/commandExecution/requestApproval': 'command',
        'item/fileChange/requestApproval': 'file', 'bridge/requestApproval': 'approval',
        'item/tool/requestUserInput': 'question',
      }
      const kind = kinds[method]
      if (!kind || typeof payload.threadId !== 'string' || typeof payload.turnId !== 'string') throw new Error('Unsupported or unowned request')
      return this.onRequest({ kind, sessionId: payload.threadId, turnId: payload.turnId, payload })
    }
  }
  async initialize(): Promise<void> {
    await this.rpc.initialize?.()
    const account = await this.rpc.request('account/read', { refreshToken: false })
    if (!account.account && account.requiresOpenaiAuth !== false) throw new Error('Codex login required')
  }
  async openSession(options: SessionOptions): Promise<{ id: string; cwd: string }> {
    const result = await this.rpc.request(options.id ? 'thread/resume' : 'thread/start', {
      ...(options.id ? { threadId: options.id } : { dynamicTools: options.tools }),
      cwd: options.cwd, approvalPolicy: options.approvalPolicy === 'never' ? 'never' : 'on-request', sandbox: 'workspace-write',
      approvalsReviewer: options.approvalPolicy === 'auto-review' ? 'auto_review' : 'user',
      ...(options.speed === 'fast' ? {serviceTier:'priority'} : options.speed === 'standard' ? {serviceTier:null} : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
    })
    const thread = object(result.thread)
    if (typeof thread.id !== 'string' || typeof thread.cwd !== 'string') throw new Error('Invalid session')
    return { id: thread.id, cwd: thread.cwd }
  }
  async startTurn(sessionId: string, text: string): Promise<string> {
    const result = await this.rpc.request('turn/start', { threadId: sessionId, input: [{ type: 'text', text }] })
    const id = object(result.turn).id
    if (typeof id !== 'string') throw new Error('Invalid turn')
    return id
  }
  async cancel(sessionId: string, turnId: string): Promise<void> { await this.rpc.request('turn/interrupt', { threadId: sessionId, turnId }) }
  async close(): Promise<void> { this.rpc.close(); await this.rpc.waitClosed?.() }
}

export class AppServer extends JsonRpcProcess {
  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'agent_imessage', title: 'Agent iMessage', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.write({ method: 'initialized' })
  }

}

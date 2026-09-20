import { Agent, type SDKAgent, type Run, type AgentOptions, type SDKCustomTool, type ModelSelection, type SDKJsonValue } from '@cursor/sdk'
import { toolCategory } from './progress.js'
import { randomUUID } from 'node:crypto'
import { BaseBackend, type SessionOptions } from './types.js'
import type { RouteConfig } from '../gateway/config.js'
import { object } from './jsonrpc.js'

export { backendFailure as cursorFailure } from './failure.js'
import { backendFailure as cursorFailure } from './failure.js'

export function modelSelection(model: string, effort = 'default', speed = 'default'): ModelSelection {
  const params = []
  if (effort !== 'default') params.push({ id: 'effort', value: effort })
  if (speed !== 'default') params.push({ id: 'fast', value: String(speed === 'fast') })
  return { id: model, ...(params.length ? { params } : {}) }
}
/** Direct SDK local runtime. Sandbox and callback ownership are always enforced. */
interface CursorTurn { id: string; run?: Run; cancelled: boolean }
export class CursorBackend extends BaseBackend {
  private agent: SDKAgent | undefined
  private active: CursorTurn | undefined
  private closed = false
  private task: Promise<void> | undefined
  constructor(private readonly route: RouteConfig, private readonly apiKey: string, private readonly sdk = Agent) { super() }
  async initialize(): Promise<void> { if (!this.apiKey) throw new Error('Cursor API key required') }
  async openSession(options: SessionOptions): Promise<{ id: string; cwd: string }> {
    if (this.closed || this.active || options.cwd !== this.route.cwd) throw new Error('Invalid session scope')
    if (this.agent) await this.agent[Symbol.asyncDispose]()
    const customTools: Record<string, SDKCustomTool> = {}
    for (const tool of options.tools) {
      if (typeof tool.name !== 'string') continue
      const name = tool.name
      customTools[name] = {
        description: String(tool.description),
        inputSchema: tool.inputSchema as Record<string, SDKJsonValue>,
        execute: async args => {
          const active = this.active
          if (!active || active.cancelled || this.closed || !this.agent) throw new Error('No owning turn')
          const result = object(await this.onRequest({ kind: 'tool', sessionId: this.agent.agentId, turnId: active.id, payload: { tool: name, arguments: args } }))
          return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.success }
        },
      }
    }
    const opts: AgentOptions = {
      apiKey: this.apiKey,
      ...(this.route.model ? { model: modelSelection(this.route.model, this.route.effort, this.route.speed) } : {}),
      ...(this.route.cursorMode === 'ask' ? { tools: [] } : {}),
      local: { cwd: this.route.cwd, settingSources: this.route.cursorSettings === 'none' ? [] : this.route.cursorSettings === 'project-user' ? ['project', 'user'] : ['project'], sandboxOptions: { enabled: this.route.approvalPolicy !== 'unrestricted' }, autoReview: this.route.approvalPolicy === 'auto-review', customTools },
    }
    this.agent = options.id ? await this.sdk.resume(options.id, opts) : await this.sdk.create(opts)
    return { id: this.agent.agentId, cwd: this.route.cwd }
  }
  async startTurn(sessionId: string, text: string): Promise<string> {
    if (this.closed || this.active || !this.agent || this.agent.agentId !== sessionId) throw new Error('Invalid turn')
    const active: CursorTurn = { id: randomUUID(), cancelled: false }
    this.active = active
    this.onEvent({ type: 'started', sessionId, turnId: active.id })
    // Return admission immediately so /stop and approvals never queue behind execution.
    this.task = this.execute(sessionId, text, active)
    return active.id
  }
  private async execute(sessionId: string, text: string, active: CursorTurn): Promise<void> {
    let status: 'completed' | 'interrupted' | 'failed' = 'failed'
    let failure: ReturnType<typeof cursorFailure> = 'unknown'
    try {
      const run = await this.agent!.send(text, this.route.cursorMode === 'plan' ? { mode: 'plan' } : {})
      active.run = run
      const progress = (phase: import('./types.js').BackendPhase, detail?: string) => {
        if (!this.closed && !active.cancelled) this.onEvent({type:'progress',sessionId,turnId:active.id,phase,runId:run.id,...(detail ? {detail} : {})})
      }
      progress('run-created')
      if (active.cancelled || this.closed) await run.cancel()
      const chunks: string[] = []
      let preview = '', lastPreview = -Infinity, modelActive = false, generating = false
      const toolStates = new Map<string, string>()
      for await (const event of run.stream()) {
        if (active.cancelled || this.closed) continue
        if (!modelActive && ['thinking','assistant','tool_call'].includes(event.type)) { modelActive = true; progress('model-active') }
        if (event.type === 'tool_call' && toolStates.get(event.call_id) !== event.status) {
          toolStates.set(event.call_id, event.status)
          progress(event.status === 'running' ? 'tool-running' : event.status === 'completed' ? 'tool-completed' : 'tool-failed',toolCategory(event.name))
        }
        if (event.type === 'assistant') for (const block of event.message.content) if (block.type === 'text') {
          chunks.push(block.text)
          if (!generating && block.text) { generating = true; progress('generating') }
          preview = (preview + block.text).slice(-8000)
          if (Date.now() - lastPreview >= 1000) {
            lastPreview = Date.now()
            this.onEvent({type:'preview',sessionId,turnId:active.id,id:active.id,text:preview})
          }
        }
      }
      const result = await run.wait()
      if (result.error) failure = cursorFailure(result.error)
      else if (result.status === 'cancelled') failure = 'aborted'
      status = active.cancelled ? 'interrupted' : result.status === 'finished' ? 'completed' : 'failed'
      if (!this.closed && status === 'completed') this.onEvent({ type: 'message', sessionId, turnId: active.id, id: active.id, text: result.result?.trim() || chunks.join('').trim() })
    } catch (error) { status = active.cancelled ? 'interrupted' : 'failed'; failure = cursorFailure(error) }
    finally {
      if (this.active === active) this.active = undefined
      if (!this.closed) this.onEvent({ type: 'completed', sessionId, turnId: active.id, status, ...(status === 'failed' ? { failure } : {}) })
    }
  }
  async cancel(sessionId: string, turnId: string): Promise<void> {
    if (sessionId !== this.agent?.agentId || turnId !== this.active?.id) return
    this.active.cancelled = true
    await this.active.run?.cancel()
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.active) { this.active.cancelled = true; await this.active.run?.cancel().catch(() => {}) }
    await this.agent?.[Symbol.asyncDispose]()
    await this.task
    this.onClose()
  }
}

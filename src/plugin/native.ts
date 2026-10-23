import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import type { } from '@deepseek-ai/dsh-agent-default-model'
import type { } from '@deepseek-ai/dsh-agent-preset-registry'
import type { } from '@deepseek-ai/dsh-permission-presets'
import { freezeMessage, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId, foldRequestHeader, interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { } from '@deepseek-ai/dsh-session-persistence'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { InteractionHandlers, InteractionScope } from './interaction-types.js'
import type { NativeHost, NativeSession, NativeResult } from './bridge.js'
import { ownsSession, type LegacySessionIdentity } from './identity.js'

// DSH 0.2 uses producer-owned message source kinds, without a generic plugin source.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-channels': { kind: 'dsh-channels' }
  }
}

export function textOf(content: readonly unknown[]): string {
  return content.flatMap(block => block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('')
}
/** Fold native log boundaries, including claimed input rejected before user/message. */
export function resultFromEvents(events: readonly SessionEvent[], inputId: string): NativeResult | undefined {
  let currentTurn: number | undefined, ownedTurn: number | undefined
  let leader: string | undefined, suppressed = false
  const inbox: Record<string, string[]> = { 'next-turn': [], 'next-step': [] }
  let text = ''
  for (const event of events) {
    if (event.type === 'turn/start') { currentTurn = event.data.turn; leader = undefined }
    if (event.type === 'agent/inbox/spliced') {
      const pending = inbox[event.data.target]!
      const removed = pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted.map(m => m.id))
      if (event.data.outcome !== 'canceled' && removed.length) leader ??= removed[0]
      if (removed.includes(inputId)) {
        if (event.data.outcome === 'canceled') return { text: '已取消。', reason: 'interrupted' }
        ownedTurn = currentTurn; suppressed = leader !== inputId
      }
    }
    if (event.type === 'user/message') {
      leader ??= event.data.id
      if (event.data.id === inputId) { ownedTurn = currentTurn; suppressed = leader !== inputId }
    }
    if (event.type === 'assistant/message' && ownedTurn !== undefined && event.data.turn === ownedTurn) text += textOf(event.data.message.content)
    if (event.type === 'turn/end') {
      if (ownedTurn !== undefined && event.data.turn === ownedTurn) return suppressed ? { text: '', reason: reasonText(event.data.reason), suppressed: true } : { text, reason: reasonText(event.data.reason) }
      currentTurn = undefined
    }
  }
  return undefined
}
function reasonText(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && 'kind' in reason && typeof reason.kind === 'string') return reason.kind
  return 'ended'
}

export class DshNativeHost implements NativeHost {
  constructor(private readonly ctx: Context, private readonly cwd: string, private readonly permissionPreset: string, private readonly binding: string, private readonly model?: {provider:string;model:string;reasoningEffort?:string | undefined}, private readonly legacyIdentity?: LegacySessionIdentity) { }
  async inspect(sessionId: string, inputId: string): Promise<NativeResult | undefined> {
    if (!sessionId) return undefined
    const snapshot = await this.ctx.sessionPersistence.stat(SessionId(sessionId))
    if (!snapshot) return undefined
    if (snapshot.header.cwd !== this.cwd || !ownsSession(sessionId, this.binding, this.legacyIdentity)) throw new Error('Session binding mismatch')
    const handle = await this.ctx.sessionPersistence.open(SessionId(sessionId), 'read')
    try {
      const events = (await handle.read()).events
      return resultFromEvents([...events, ...interruptedTurnClosers(events)], inputId)
    }
    finally { await handle.close() }
  }
  async open(id?: string): Promise<NativeSession> {
    // Never adopt another consumer's live agent, even when workspace matches.
    if (id && this.ctx.agents.get(SessionId(id))) throw new Error('Channel session already owned')
    let selection = this.model ? {provider:this.model.provider,model:this.model.model,...(this.model.reasoningEffort === undefined ? {} : {reasoningEffort:ReasoningEffortId(this.model.reasoningEffort)})} : this.ctx.agentDefaultModel.currentSelection()
    let preset = this.ctx.agentPresets.defaultId
    if (id) {
      const snapshot = await this.ctx.sessionPersistence.stat(SessionId(id))
      if (!snapshot || snapshot.header.cwd !== this.cwd || !ownsSession(id, this.binding, this.legacyIdentity)) throw new Error('Session binding mismatch')
      preset = snapshot.header.agentPreset ?? preset
      const stored = await this.ctx.sessionPersistence.open(SessionId(id), 'read')
      try {
        const events = (await stored.read()).events
        const config = foldRequestHeader(events)?.config
        if (config) selection = { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
        for (const event of events) if (event.type === 'agent-preset/selected') preset = event.data.agentPreset ?? this.ctx.agentPresets.defaultId
      } finally { await stored.close() }
    }
    this.ctx.permissionPresets.resolve(this.permissionPreset)
    const setup = async (agentCtx: Context) => {
      await this.ctx.agentPresets.mount(agentCtx, preset)
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }
    const options = { provider: selection.provider, model: selection.model }
    const handle = id ? await this.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: options, setup })
      : await this.ctx.agents.create({ sessionId: SessionId(`channels-${this.binding}-${randomUUID()}`), meta: { cwd: this.cwd, agentPreset: preset }, agentOptions: options, setup })
    try {
      // New sessions select an existing host permission preset; resumed sessions retain their durable policy.
      if (!id) this.ctx.permissionPresets.set(handle.agent.session, this.permissionPreset)
      if (id) handle.agent.inbox.clear() // Quarantined old inputs must never wake behind a new prompt.
      await this.flush(handle.agent)
      return this.bind(handle)
    } catch (error) { await handle.dispose(); throw error }
  }
  private async flush(agent: Agent): Promise<void> {
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('DSH session durability unavailable')
  }
  private bind(handle: AgentHandle): NativeSession {
    const agent = handle.agent
    // These feeds are scope-filtered: registering on the Agent's own context keeps every
    // other session's traffic out of this binding and unwinds automatically on disposal.
    const scoped = agent.ctx
    const pending = new Map<string, { turn?: number; suppressed?: boolean; text: string; resolve: (value: NativeResult) => void; progress: () => void; controller:AbortController; interactions?:InteractionHandlers | undefined }>()
    const leaders = new Map<number, string>()
    const claimed = scoped.on('agent/inbox/claimed', payload => {
      if (payload.agent !== agent) return
      // Every native claimant counts, including input from the host UI or scheduler.
      if (!leaders.has(payload.turn)) leaders.set(payload.turn, payload.message.id)
      const input = pending.get(payload.message.id)
      if (input) {
        input.suppressed = leaders.get(payload.turn) !== payload.message.id
        input.turn = payload.turn
      }
    })
    const discarded = scoped.on('agent/inbox/discarded', payload => {
      if (payload.agent !== agent) return
      finish(payload.message.id, { text: '已取消。', reason: 'interrupted' })
    })
    const finish = (id: string, result: NativeResult) => {
      const input = pending.get(id)
      if (!input) return
      input.controller.abort()
      pending.delete(id)
      const normalize = (value: NativeResult): NativeResult => input.suppressed ? {text:'',reason:value.reason,suppressed:true} : value
      // Turn completion is not a durability barrier. No reply before flush.
      void this.flush(agent).then(() => input.resolve(normalize(result)), () => input.resolve(normalize({ text: 'DSH 日志落盘未确认；请检查本机会话。', reason: 'uncertain' })))
    }
    const events = scoped.on('session/event', (session, event) => {
      if (session !== agent.session) return
      for (const [id, input] of pending) {
        if (input.turn === undefined) continue
        if (event.type === 'assistant/message' && event.data.turn === input.turn) input.text += textOf(event.data.message.content)
        if (event.type === 'step/start' && event.data.turn === input.turn) input.progress()
        if (event.type === 'turn/end' && event.data.turn === input.turn) finish(id, input.suppressed ? { text: '', reason: reasonText(event.data.reason), suppressed: true } : { text: input.text, reason: reasonText(event.data.reason) })
      }
      if (event.type === 'turn/end') leaders.delete(event.data.turn)
    })
    const disposed = scoped.on('agent/disposed', payload => {
      if (payload.agent === agent) for (const id of pending.keys()) finish(id, { text: 'DSH 会话已停止。', reason: 'interrupted' })
    })
    const owner = (requestAgent: unknown) => {
      if (requestAgent !== agent || this.ctx.agents.get(agent.id) !== agent) return undefined
      let turn: number | undefined
      for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'turn/start') turn = event.data.turn
        if (event.type === 'turn/end') turn = undefined
      }
      if (turn === undefined) return undefined
      for (const [id,input] of pending) if (input.turn === turn && !input.suppressed && leaders.get(turn) === id && !input.controller.signal.aborted) return {id,input,turn}
      return undefined
    }
    const scopeFor = (owned: NonNullable<ReturnType<typeof owner>>, signal?: AbortSignal): InteractionScope => ({
      sessionId:agent.id,inputId:owned.id,turn:owned.turn,
      signal:signal ? AbortSignal.any([signal,owned.input.controller.signal]) : owned.input.controller.signal,
      current:() => {const live=owner(agent);return live?.input===owned.input && live.turn===owned.turn},
    })
    // Delegate first, including handlers registered later. Never race or override the host.
    const approval = scoped.on('approval/request',async (request,next) => {
      const owned=owner(request.agent)
      if (!owned?.input.interactions) return next()
      const outcome=await next()
      if (outcome !== 'unavailable') return outcome
      const base=scopeFor(owned,request.signal)
      const scope={...base,current:() => base.current() && (this.ctx.approval.overrideOf(agent.session) ?? this.ctx.approval.config.policy ?? 'ask') === 'ask'}
      if (!scope.current() || scope.signal.aborted) return 'cancelled'
      return owned.input.interactions.approval({...scope,toolName:request.toolName,reason:request.reason,displayReason:request.displayReason,callId:request.callId})
    })
    const questions = scoped.on('user-questions/request',async (request,next) => {
      const owned=owner(request.agent)
      if (!owned?.input.interactions) return next()
      try {return await next()} catch (error) {
        if (!(error instanceof UserQuestionError) || error.code !== 'NO_PROVIDER') throw error
      }
      const scope=scopeFor(owned,request.signal)
      if (!scope.current() || scope.signal.aborted) throw new UserQuestionError('渠道问答所属执行已结束。','ASK_ABORTED')
      return owned.input.interactions.question({...scope,questions:request.questions})
    })
    return {
      id: agent.id,
      submit: (id, text, progress, interactions) => {
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<NativeResult>((resolve, reject) => {
          rejectResult = reject
          pending.set(id, {text:'',resolve,progress,interactions,controller:new AbortController()})
        })
        try {
          const message = freezeMessage({ id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-channels' } })
          // No await between status and native admission. DSH resolves closing/abort races.
          const ownsTurn = [...pending].some(([inputId,input]) => input.turn !== undefined && !input.suppressed && !input.controller.signal.aborted && leaders.get(input.turn) === inputId)
          if (agent.status === 'running' && ownsTurn) agent.steer(message)
          else agent.followup(message)
          const admitted = this.flush(agent)
          void admitted.catch(() => { for(const input of pending.values())input.controller.abort();agent.cancel({ kind: 'user' }); finish(id,{text:'DSH 入队落盘未确认；请检查本机会话。',reason:'uncertain'}) })
          return { admitted, result }
        } catch (error) {
          pending.delete(id); rejectResult(error)
          return { admitted: Promise.reject(error), result }
        }
      },
      cancel: () => {for(const input of pending.values())input.controller.abort();agent.cancel({kind:'user'})},
      close: async () => {
        for(const input of pending.values())input.controller.abort()
        try { await handle.dispose() }
        finally {
          for (const input of pending.values()) {input.controller.abort();input.resolve(input.suppressed ? {text:'',reason:'interrupted',suppressed:true} : { text: 'DSH 会话已停止。', reason: 'interrupted' })}
          pending.clear(); claimed(); discarded(); events(); disposed();approval();questions()
        }
      },
    }
  }
}

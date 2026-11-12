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
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { sendApprovedMedia } from './approved-media.js'
import type { InteractionHandlers, InteractionScope } from './interaction-types.js'
import type { NativeHost, NativeSession, NativeResult, NativePreferences } from './bridge.js'
import { ownsSession, type LegacySessionIdentity } from './identity.js'
import {installQQAgent} from './qqbot-agent.js'
import type {ToolDispatchExecution} from '@deepseek-ai/dsh-tools'
import type {QQPresentationOptions} from './qqbot-presentation.js'
import { channelMediaTool, type ChannelMediaArgs } from './media-tool.js'
import type { MediaHandler } from './media-delivery.js'

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
  private preferences:NativePreferences={}
  configure(preferences:NativePreferences){this.preferences=preferences}
  constructor(private readonly ctx: Context, private readonly cwd: string, private readonly permissionPreset: string, private readonly binding: string, private readonly model?: {provider:string;model:string;reasoningEffort?:string | undefined}, private readonly legacyIdentity?: LegacySessionIdentity, private readonly channelKind?: string, private readonly lifetime: Context = ctx, private readonly qqVision?:{provider:string;model:string}|undefined,private readonly qqOptions:QQPresentationOptions&{streaming?:boolean}={}) { }
  async inspect(sessionId: string, inputId: string): Promise<NativeResult | undefined> {
    if (!sessionId) return undefined
    const snapshot = await this.lifetime.sessionPersistence.stat(SessionId(sessionId))
    if (!snapshot) return undefined
    if (snapshot.header.cwd !== this.cwd || !ownsSession(sessionId, this.binding, this.legacyIdentity)) throw new Error('Session binding mismatch')
    const handle = await this.lifetime.sessionPersistence.open(SessionId(sessionId), 'read')
    try {
      const events = (await handle.read()).events
      return resultFromEvents([...events, ...interruptedTurnClosers(events)], inputId)
    }
    finally { await handle.close() }
  }
  async open(id?: string, bindingSignal?: AbortSignal): Promise<NativeSession> {
    // Root ownership must not make an unfinished creation outlive its binding.
    // Detach explicitly after open: SDK cancellation is creation-only, and a
    // later transport stop must not reach the successfully shared Agent.
    const creation = new AbortController()
    const abort = () => creation.abort(bindingSignal?.reason)
    bindingSignal?.addEventListener('abort', abort, { once: true })
    if (bindingSignal?.aborted) abort()
    try { return await this.openSession(id, creation.signal) }
    finally { bindingSignal?.removeEventListener('abort', abort) }
  }
  private async openSession(id: string | undefined, signal: AbortSignal): Promise<NativeSession> {
    signal.throwIfAborted()
    if (id) {
      if (!ownsSession(id, this.binding, this.legacyIdentity)) throw new Error('Session binding mismatch')
      const live = this.ctx.agents.get(SessionId(id))
      if (live) return this.attach(live)
    }
    let selection = this.model ? {provider:this.model.provider,model:this.model.model,...(this.model.reasoningEffort === undefined ? {} : {reasoningEffort:ReasoningEffortId(this.model.reasoningEffort)})} : this.ctx.agentDefaultModel.currentSelection()
    let preset = this.preferences.preset??this.ctx.agentPresets.defaultId
    if (id) {
      const snapshot = await this.ctx.sessionPersistence.stat(SessionId(id), { signal })
      signal.throwIfAborted()
      if (!snapshot || snapshot.header.cwd !== this.cwd || !ownsSession(id, this.binding, this.legacyIdentity)) throw new Error('Session binding mismatch')
      preset = snapshot.header.agentPreset ?? preset
      const stored = await this.ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
      try {
        const events = (await stored.read(0, undefined, { signal })).events
        signal.throwIfAborted()
        const config = foldRequestHeader(events)?.config
        if (config) selection = { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
        for (const event of events) if (event.type === 'agent-preset/selected') preset = event.data.agentPreset ?? this.ctx.agentPresets.defaultId
      } finally { await stored.close() }
    }
    if(this.preferences.model)selection=this.preferences.model
    this.ctx.permissionPresets.resolve(this.permissionPreset)
    const setup = async (agentCtx: Context) => {
      signal.throwIfAborted()
      await this.ctx.agentPresets.mount(agentCtx, preset)
      signal.throwIfAborted()
      installModelSelection(agentCtx)
    }
    const options = { ...selection }
    let handle: AgentHandle
    try {
      handle = id ? await this.lifetime.agents.resume({ resumeSessionId: SessionId(id), agentOptions: options, setup, signal })
        : await this.lifetime.agents.create({ sessionId: SessionId(`channels-${this.binding}-${randomUUID()}`), meta: { cwd: this.cwd, agentPreset: preset }, agentOptions: options, setup, signal })
    } catch (error) {
      signal.throwIfAborted()
      // Desktop can claim the session while the plugin is reading its saved state.
      const live = id && error instanceof Error && error.name === 'SessionAlreadyOwnedError'
        ? this.ctx.agents.get(SessionId(id)) : undefined
      if (live) return this.attach(live)
      throw error
    }
    try {
      signal.throwIfAborted()
      // New sessions select an existing host permission preset; resumed sessions retain their durable policy.
      if (!id) this.ctx.permissionPresets.set(handle.agent.session, this.permissionPreset)
      if (id) handle.agent.inbox.clear() // Quarantined old inputs must never wake behind a new prompt.
      await this.flush(handle.agent)
      signal.throwIfAborted()
      return this.bind(handle.agent, handle)
    } catch (error) { await handle.dispose(); throw error }
  }
  private async flush(agent: Agent): Promise<void> {
    if (!await this.lifetime.sessions.flush(agent.session)) throw new Error('DSH session durability unavailable')
  }
  private attach(agent: Agent): NativeSession {
    // DSH 0.2.2-rc.2 removed `AgentRegistry.roots()`; classify the live entry from
    // its durable Session header and require the exact registry instance instead.
    const header = agent.session.header
    const topLevel = header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
    if (agent.session.id !== agent.id || header.cwd !== this.cwd || !topLevel || this.ctx.agents.get(agent.id) !== agent) {
      throw new Error('Session binding mismatch')
    }
    // The desktop retains its Agent handle, inbox, model and policy.
    return this.bind(agent)
  }
  private bind(agent: Agent, handle?: AgentHandle): NativeSession {
    let live = true
    // These feeds are scope-filtered: registering on the Agent's own context keeps every
    // other session's traffic out of this binding and unwinds automatically on disposal.
    const scoped = agent.ctx
    let closing=false
    const finishing=new Set<Promise<void>>()
    type PendingInput = { turn?: number; suppressed?: boolean; text: string; resolve: (value: NativeResult) => void; progress: () => void; controller:AbortController; interactions?:InteractionHandlers | undefined; media?:MediaHandler | undefined; stream?:((text:string)=>void)|undefined; notice?:((text:string)=>Promise<void>)|undefined; streamedText?:string; watchdog?:ReturnType<typeof setTimeout>|undefined }
    const pending = new Map<string, PendingInput>()
    const stopWatchdog = (input: PendingInput) => {
      if (input.watchdog !== undefined) clearTimeout(input.watchdog)
      input.watchdog = undefined
    }
    const leaders = new Map<number, string>()
    const claimed = scoped.on('agent/inbox/claimed', payload => {
      if (payload.agent !== agent) return
      // Every native claimant counts, including input from the host UI or scheduler.
      if (!leaders.has(payload.turn)) leaders.set(payload.turn, payload.message.id)
      const input = pending.get(payload.message.id)
      if (input) {
        stopWatchdog(input)
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
      stopWatchdog(input)
      // During teardown the SDK owns the final drain. Calling live-session
      // flush concurrently with handle disposal races its writer removal.
      if(closing){input.controller.abort();return}
      input.controller.abort()
      pending.delete(id)
      const normalize = (value: NativeResult): NativeResult => input.suppressed ? {text:'',reason:value.reason,suppressed:true} : value
      // Turn completion is not a durability barrier. No reply before flush.
      const completion=this.flush(agent).then(() => input.resolve(normalize(result)), () => input.resolve(normalize({ text: 'DSH 日志落盘未确认；请检查本机会话。', reason: 'uncertain' })))
      finishing.add(completion)
      void completion.finally(()=>finishing.delete(completion))
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
    let streamingInput:string|undefined,streamAttempt:string|undefined
    const streamed = scoped.on('agent/assistant-stream', payload => {
      if(payload.agent!==agent)return
      const frame=payload.frame
      if(frame.type==='start'){streamAttempt=frame.attemptId;streamingInput=[...pending].find(([,input])=>input.turn===frame.turn&&!input.suppressed&&!input.controller.signal.aborted)?.[0]}
      const owned=streamAttempt===frame.attemptId&&streamingInput?pending.get(streamingInput):undefined
      if(!owned?.stream)return
      if(frame.type==='start')owned.streamedText=owned.text
      if(frame.type==='chunk'&&frame.chunk.type==='text-delta'){owned.streamedText=(owned.streamedText??owned.text)+frame.chunk.text;owned.stream(owned.streamedText)}
    })
    const disposed = scoped.on('agent/disposed', payload => {
      if (payload.agent !== agent) return
      live = false
      for (const id of pending.keys()) finish(id, { text: 'DSH 会话已停止。', reason: 'interrupted' })
    })
    const owner = (requestAgent: unknown, includeCancelled = false) => {
      if (requestAgent !== agent || this.ctx.agents.get(agent.id) !== agent) return undefined
      let turn: number | undefined
      for (const event of agent.session.snapshotEvents()) {
        if (event.type === 'turn/start') turn = event.data.turn
        if (event.type === 'turn/end') turn = undefined
      }
      if (turn === undefined) return undefined
      for (const [id,input] of pending) if (input.turn === turn && !input.suppressed && leaders.get(turn) === id && (includeCancelled || !input.controller.signal.aborted)) return {id,input,turn}
      return undefined
    }
    const scopeFor = (owned: NonNullable<ReturnType<typeof owner>>, signal?: AbortSignal): InteractionScope => ({
      sessionId:agent.id,inputId:owned.id,turn:owned.turn,
      signal:signal ? AbortSignal.any([signal,owned.input.controller.signal]) : owned.input.controller.signal,
      current:() => {const live=owner(agent);return live?.input===owned.input && live.turn===owned.turn},
    })
    // Only the exact channel-owned Agent can invoke this scoped outbound capability.
    // The recipient is fixed, and all file access goes through the channel Agent’s DSH filesystem.
    const mediaTool = scoped.get?.('tools')
    const sendChannelMedia = async (args:ChannelMediaArgs, exec:Pick<ToolDispatchExecution,'agent'|'callId'|'signal'>) => {
      const owned = owner(exec.agent)
      if (!owned?.input.media) throw new Error('Media sending requires an active channel-owned turn.')
      return sendApprovedMedia(this.ctx, { agent, cwd:this.cwd, args, callId:exec.callId,
        scope:scopeFor(owned, exec.signal), deliver:owned.input.media, flush:()=>this.flush(agent), channelKind:this.channelKind })
    }
    let noticeTail=Promise.resolve()
    const mediaDisposers=mediaTool?[mediaTool.register(channelMediaTool(sendChannelMedia))]:[]
    const qqAgent=this.channelKind==='qqbot'?installQQAgent(this.ctx,agent,{
      cwd:this.cwd,options:this.qqOptions,sendMedia:sendChannelMedia,
      selection:()=>this.qqVision??this.preferences.model??this.model??this.ctx.agentDefaultModel.currentSelection(),
      scope:(candidate,signal)=>{const owned=owner(candidate);return owned?scopeFor(owned,signal):undefined},
      notice:text=>{const owned=owner(agent);if(owned?.input.notice){const send=owned.input.notice;noticeTail=noticeTail.then(()=>send(text)).catch(()=>{})}},
    }):()=>{}
    const unregisterMedia=()=>{qqAgent();for(const dispose of mediaDisposers.splice(0))dispose()}
    // Plugin unload and Agent teardown both own this scoped registration.
    const releaseMedia = mediaTool ? this.ctx.effect(() => unregisterMedia) : () => {}
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
    const isLive = () => live && (handle !== undefined || this.ctx.agents.get(agent.id) === agent)
    const cancel = (failedId?: string) => {
      if (!isLive()) return
      const cancelTurn = !!owner(agent)
      for (const input of pending.values()) input.controller.abort()
      // Input ownership is independent of who created the Agent handle. Desktop
      // work can share either a channel-created or a desktop-created session.
      for (const id of pending.keys()) {
        if (agent.inbox.remove(MessageId(id)) && id !== failedId) finish(id, { text: '已取消。', reason: 'interrupted' })
      }
      if (cancelTurn) agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    return {
      id: agent.id,
      isLive,
      submit: (id, text, progress, interactions, media, stream, notice) => {
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<NativeResult>((resolve, reject) => {
          rejectResult = reject
          const entry: PendingInput={ text: '', resolve, progress, interactions, media, stream, notice, controller: new AbortController(), watchdog: undefined as ReturnType<typeof setTimeout>|undefined }
          pending.set(id, entry)
          // A Host that neither claims nor discards an admitted input must not pin the binding forever.
          entry.watchdog = setTimeout(() => {
            entry.watchdog = undefined
            if (pending.get(id) !== entry || entry.turn !== undefined || closing) return
            // Revoke the native admission before settling: it must never execute later.
            agent.inbox.remove(MessageId(id))
            if (pending.get(id) === entry && entry.turn === undefined) finish(id, { text: 'DSH 长时间未接管此请求，已撤销排队；请检查会话。未自动重跑。', reason: 'interrupted' })
          }, 30 * 60_000)
          entry.watchdog.unref?.()
        })
        try {
          if (!isLive()) throw new Error('Channel session is no longer live')
          const message = freezeMessage({ id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-channels' } })
          // No await between status and native admission. DSH resolves closing/abort races.
          const ownsTurn = [...pending].some(([inputId,input]) => input.turn !== undefined && !input.suppressed && !input.controller.signal.aborted && leaders.get(input.turn) === inputId)
          if (agent.status === 'running' && ownsTurn) agent.steer(message)
          else agent.followup(message)
          const admitted = this.flush(agent)
          void admitted.catch(() => {
            cancel(id)
            finish(id, { text: 'DSH 入队落盘未确认；请检查本机会话。', reason: 'uncertain' })
          })
          return { admitted, result }
        } catch (error) {
          const input = pending.get(id)
          if (input) stopWatchdog(input)
          pending.delete(id); rejectResult(error)
          return { admitted: Promise.reject(error), result }
        }
      },
      cancel: () => cancel(),
      close: async () => {
        // A lifecycle handle is not exclusive input ownership. If desktop work
        // still uses this Agent, leave the handle with its native host context.
        const foreignQueued = [...(agent.inbox.nextTurn ?? []), ...(agent.inbox.nextStep ?? [])]
          .some(message => !pending.has(message.id))
        const retainForDesktop = foreignQueued || agent.status === 'running' && !owner(agent, true)
        closing=true
        cancel()
        live = false
        for(const input of pending.values())input.controller.abort()
        try {
          await Promise.all([...finishing])
          if (!retainForDesktop) await handle?.dispose()
          else if(pending.size)await this.flush(agent)
        }
        finally {
          for (const [id,input] of pending) {
            stopWatchdog(input)
            input.controller.abort()
            let stored:NativeResult|undefined
            try{stored=await this.inspect(agent.id,id)}catch{}
            input.resolve(input.suppressed ? {text:'',reason:'interrupted',suppressed:true} : stored??{text:'DSH 会话已停止；此请求的持久化状态未确认，未自动重跑。',reason:'uncertain'})
          }
          pending.clear(); claimed(); discarded(); events(); streamed(); disposed();questions();unregisterMedia();releaseMedia();await noticeTail
        }
      },
    }
  }
}

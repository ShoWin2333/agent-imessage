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
import { prepareVoiceMedia } from './audio-preparation.js'
import type { InteractionHandlers, InteractionScope } from './interaction-types.js'
import type { NativeHost, NativeSession, NativeResult } from './bridge.js'
import { ownsSession, type LegacySessionIdentity } from './identity.js'
import { channelMediaTool } from './media-tool.js'
import { loadOutboundMedia, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../media.js'
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
  constructor(private readonly ctx: Context, private readonly cwd: string, private readonly permissionPreset: string, private readonly binding: string, private readonly model?: {provider:string;model:string;reasoningEffort?:string | undefined}, private readonly legacyIdentity?: LegacySessionIdentity, private readonly channelKind?: string, private readonly lifetime: Context = ctx) { }
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
    let preset = this.ctx.agentPresets.defaultId
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
    this.ctx.permissionPresets.resolve(this.permissionPreset)
    const setup = async (agentCtx: Context) => {
      signal.throwIfAborted()
      await this.ctx.agentPresets.mount(agentCtx, preset)
      signal.throwIfAborted()
      // 0.2.1 consumes this entry-point-owned state. 0.2.2 owns model
      // selection on the Agent and ignores the extra argument. A shared
      // call signature keeps both public installers type-safe.
      const state = { current: selection, assembled: undefined }
      const install: (ctx: Context, selectionState: typeof state) => () => void = installModelSelection
      install(agentCtx, state)
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
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('DSH session durability unavailable')
  }
  private attach(agent: Agent): NativeSession {
    if (agent.session.id !== agent.id || agent.session.header.cwd !== this.cwd || !this.ctx.agents.roots().includes(agent)) {
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
    const pending = new Map<string, { turn?: number; suppressed?: boolean; text: string; resolve: (value: NativeResult) => void; progress: () => void; controller:AbortController; interactions?:InteractionHandlers | undefined; media?:MediaHandler | undefined }>()
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
    const unregisterMedia = mediaTool ? mediaTool.register(channelMediaTool(async (args, exec) => {
      const owned = owner(exec.agent)
      if (!owned?.input.media) throw new Error('Media sending requires an active channel-owned turn.')
      const scope = scopeFor(owned, exec.signal)
      const ensureCurrent = () => { if (!scope.current() || scope.signal.aborted) throw new Error('Media send cancelled or channel turn ended.') }
      ensureCurrent()
      const approval = this.ctx.get('approval')
      if (!approval) throw new Error('Media upload approval is unavailable.')
      const reason = `Upload ${args.kind} file ${args.path} to this channel's configured recipient.`
      const mediaKind = { image: '图片', file: '文件', voice: '语音' }[args.kind]
      const outcome = await approval.request({ agent, toolName: 'channel_send_media', callId: exec.callId, reason,
        displayReason: { en: reason, zh: `将工作区中的${mediaKind}「${args.path}」发送到当前渠道。` }, signal: scope.signal })
      if (outcome !== 'allowed-once') throw new Error('Media upload was not approved.')
      ensureCurrent()
      // Desktop can provide fs outside the preset. Use the Agent’s visible DSH
      // service in that case, while keeping an isolated preset provider first.
      const reader = this.ctx.agentPresets.serviceFor(agent, 'fs') ?? scoped.get('fs')
      if (!reader) throw new Error('The channel Agent has no filesystem provider for media reads.')
      let media = await loadOutboundMedia({ rawPath: args.path, kind: args.kind === 'voice' ? 'audio' : args.kind,
        workspaceCwd: this.cwd, maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, signal: scope.signal, reader })
      ensureCurrent()
      let preparationNote: string | undefined
      if (args.kind === 'voice' && (this.channelKind === 'telegram' || this.channelKind === 'discord')) {
        const presets = this.ctx.agentPresets
        const policy = presets.serviceFor(agent, 'sandboxPolicy')?.resolve({ session: agent.session })
        const subprocess = presets.serviceFor(agent, 'subprocess'), sandbox = presets.serviceFor(agent, 'sandbox')
        const prepared = await prepareVoiceMedia(media, {
          ...(subprocess ? { subprocess } : {}), ...(sandbox ? { sandbox } : {}),
          ...(policy ? { policy } : {}), cwd: this.cwd,
        }, scope.signal)
        media = prepared.media
        if (prepared.status === 'unavailable') preparationNote = prepared.note
        ensureCurrent()
      }
      // Commit the tool call and approval before any external media side effect.
      await this.flush(agent)
      ensureCurrent()
      const result = await owned.input.media({ ...scope, callId: exec.callId, kind: args.kind, media })
      return preparationNote && result.mode === 'file' ? { ...result, reason: preparationNote } : result
    })) : () => {}
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
      submit: (id, text, progress, interactions, media) => {
        let rejectResult!: (reason: unknown) => void
        const result = new Promise<NativeResult>((resolve, reject) => {
          rejectResult = reject
          pending.set(id, {
            text: '', resolve, progress, interactions, media, controller: new AbortController(),
          })
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
        cancel()
        live = false
        for(const input of pending.values())input.controller.abort()
        try { if (!retainForDesktop) await handle?.dispose() }
        finally {
          for (const input of pending.values()) {input.controller.abort();input.resolve(input.suppressed ? {text:'',reason:'interrupted',suppressed:true} : { text: 'DSH 会话已停止。', reason: 'interrupted' })}
          pending.clear(); claimed(); discarded(); events(); disposed();questions();unregisterMedia();releaseMedia()
        }
      },
    }
  }
}

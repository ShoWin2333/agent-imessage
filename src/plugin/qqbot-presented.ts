import type { Context } from '@deepseek-ai/cordis'
import type { ChannelBridge, BindingState } from './bridge.js'
import type { ChannelAdapter } from '../channels/types.js'
import type { QQPresentationOptions } from './qqbot-presentation.js'
import { sendApprovedMedia } from './approved-media.js'
import { bounded } from './delivery.js'

/** One present hook for channel, desktop and scheduled turns of the exact bound session. */
export function registerQQPresented(ctx: Context, input: {
  state: () => BindingState; bridge: ChannelBridge; adapter: ChannelAdapter; cwd: string
  policy: 'off' | 'c2c'; signal: AbortSignal; options: QQPresentationOptions
}) {
  let lastTurn = '', fileCount = 0
  const seen = new Set<string>()
  // A best-effort channel notice must never turn a successful native tool into an error.
  const notice = async (text: string) => {
    try { if (!input.signal.aborted) await bounded((await input.adapter.scheduledMessage!('qq-present-notice', '')).send(text), 30000, input.signal) }
    catch { /* The native declaration and workspace file remain available. */ }
  }
  return ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const agent = exec.agent
      if (!agent || agent.id !== input.state().sessionId || agent.session.header.cwd !== input.cwd
        || ctx.agents.get(agent.id) !== agent || exec.name !== 'present' || result.isError || decision.kind !== 'accept'
        || input.options.sendPresentedFiles === false || input.signal.aborted) return decision
      const events = agent.session.snapshotEvents(), start = events.findLastIndex(e => e.type === 'turn/start' || e.type === 'turn/end')
      const boundary = events[start]
      if (boundary?.type !== 'turn/start') return decision
      const turn = boundary.data.turn, messages = events.slice(start).filter(e => e.type === 'user/message')
      if (!messages.length) return decision
      const channelOwned = messages.some(e => e.type === 'user/message' && e.data.source.kind === 'dsh-channels')
      const desktop = messages.some(e => e.type === 'user/message' && e.data.source.kind === 'user' && (e.data.source as { form?: string }).form !== 'notice')
      if (!channelOwned && desktop && input.policy === 'off') return decision
      const declaration = 'value' in decision ? decision.value : result.value
      if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration) || !Array.isArray(declaration.files)) return decision
      const signal = AbortSignal.any([exec.signal, input.signal])
      const current = () => {
        const latest = agent.session.snapshotEvents().findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
        return !signal.aborted && agent.id === input.state().sessionId && ctx.agents.get(agent.id) === agent
          && latest?.type === 'turn/start' && latest.data.turn === turn
      }
      const turnKey = `${agent.id}:${turn}`
      if (lastTurn !== turnKey) { lastTurn = turnKey; fileCount = 0; seen.clear() }
      if (seen.has(exec.callId)) return decision
      seen.add(exec.callId)
      // Await uploads before present completes, while its native approval turn is alive.
      for (const [index, file] of declaration.files.entries()) {
        if (!file || typeof file !== 'object' || Array.isArray(file) || typeof file.path !== 'string' || !current()) continue
        const callId = `present:${exec.callId}:${index}`
        if (input.state().receipts.some(r => r.id === `qq-present:${agent.id}:${callId}` && r.media?.length)) continue
        if (fileCount++ >= (input.options.maxFiles ?? 4)) { await notice(`📎 ${file.path}：超出本轮交付上限，未发送。`); continue }
        try {
          const message = await input.adapter.scheduledMessage!(`qq-present:${exec.callId}`, '')
          const sent = await sendApprovedMedia(ctx, {
            agent, cwd: input.cwd, args: { path: file.path, kind: 'file' }, callId,
            scope: { sessionId: agent.id, inputId: `present:${exec.callId}`, turn, signal, current },
            flush: async () => { if (!await ctx.sessions.flush(agent.session)) throw new Error('Not committed') },
            deliver: request => input.bridge.deliverExternalMedia(message, request),
          })
          if (sent.delivery !== 'sent') throw new Error('Uncertain')
        } catch {
          if (current()) await notice(`📎 ${file.path}：未获批准、读取受限或投递未确认；文件仍保留在工作区，未自动重试。`)
        }
      }
    } catch { /* Optional QQ presentation cannot invalidate the native tool result. */ }
    return decision
  }, { global: true })
}

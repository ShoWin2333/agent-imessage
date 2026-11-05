import { Context, type Events } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalInteraction } from './interaction-types.js'

type ChannelAnswerer = (request: ApprovalInteraction, settled: Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
const continuationMarker = Symbol('channel-approval-continuation')

function openTurn(agent: ApprovalRequestEvent['agent']): number | undefined {
  const event = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
  return event?.type === 'turn/start' ? event.data.turn : undefined
}

/** DSH owns the request and audit. Both surfaces answer that one request. */
export function registerSharedApprovals(
  ctx: Context,
  ownsSession: (request: ApprovalRequestEvent) => boolean,
  channel: ChannelAnswerer,
): () => void {
  const lifetime = new AbortController()
  const answer: Events['approval/request'] = async function (request, next) {
    if (lifetime.signal.aborted || !ownsSession(request)) return next()
    const service = ctx.get('approval')
    const { agent } = request
    const turn = openTurn(agent)
    if (!service || turn === undefined) return next()

    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, lifetime.signal, ...(request.signal ? [request.signal] : [])])
    const current = () => !signal.aborted && ownsSession(request) && openTurn(agent) === turn
      && (service.overrideOf(agent.session) ?? service.config.policy ?? 'ask') === 'ask'
    if (!current()) return 'cancelled'

    const releaseEvents = ctx.on('session/event', (session, event) => {
      if (session === agent.session && (event.type === 'turn/end' || event.type === 'approval/policy') && !current()) stop.abort()
    })
    const releaseAgent = ctx.on('agent/disposed', event => {
      if (event.agent === agent) stop.abort()
    })

    const settled = Promise.withResolvers<ApprovalOutcome>()
    const desktopRequest: ApprovalRequestEvent = { ...request, signal }
    const desktop = approvalContinuation(ctx, this, answer, desktopRequest)
    const decision = async (answer: () => Promise<ApprovalOutcome>) => {
      const result = await answer()
      if (!current() || (result !== 'allowed-once' && result !== 'rejected')) throw new Error('No active approval decision')
      return result
    }
    let outcome: ApprovalOutcome = 'unavailable'
    const aborted = Promise.withResolvers<ApprovalOutcome>()
    const abort = () => aborted.resolve('cancelled')
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Only the channel reply capability has an expiry. The desktop retains
      // its native request lifetime if the channel expires or is unavailable.
      outcome = await Promise.race([Promise.any([
        decision(desktop),
        decision(() => channel({ ...request, sessionId: agent.id, turn, signal, current }, settled.promise)),
      ]).catch((): ApprovalOutcome => 'unavailable'), aborted.promise])
      if (!current()) outcome = 'cancelled'
    } catch {
      if (!current()) outcome = 'cancelled'
    } finally {
      settled.resolve(outcome)
      stop.abort()
      signal.removeEventListener('abort', abort)
      releaseEvents()
      releaseAgent()
    }
    return outcome
  }
  // Cordis wraps registered callbacks for tracing; a symbol survives that proxy.
  Object.defineProperty(answer, continuationMarker, { value: answer })
  const unregister = ctx.on('approval/request', answer, { prepend: true })
  return () => { lifetime.abort(); unregister() }
}

/**
 * Continue the answerer chain once, using a cancellable request copy.
 * Cordis 4.0.5's next() closes over the original arguments and cannot accept a
 * replacement request. Its exported hook records provide the downstream slice;
 * keep this compatibility seam here until Cordis supports argument replacement.
 * No hook or borrowed request is modified, and upstream middleware is not replayed.
 */
function approvalContinuation(
  ctx: Context,
  target: ThisParameterType<Events['approval/request']>,
  current: Events['approval/request'],
  request: ApprovalRequestEvent,
): () => Promise<ApprovalOutcome> {
  const hooks = ctx.events._hooks['approval/request'] ?? []
  const index = hooks.findIndex(hook => Reflect.get(hook.callback, continuationMarker) === current)
  if (index < 0) return async () => 'unavailable'
  const filter = (target as { [Context.filter]?: (ctx: Context) => boolean })[Context.filter]
  const callbacks = hooks.slice(index + 1)
    .filter(hook => hook.global || !filter || filter.call(target, hook.ctx))
    .map(hook => hook.callback as Events['approval/request'])
  let cursor = 0
  const next = async (): Promise<ApprovalOutcome> => {
    const callback = callbacks[cursor++]
    return callback ? callback.call(target, request, next) : 'unavailable'
  }
  return next
}

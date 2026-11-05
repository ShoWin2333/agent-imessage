import type { Context, Events } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { ApprovalInteraction } from './interaction-types.js'

type ChannelAnswerer = (request: ApprovalInteraction, settled: Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>

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
        // Continue the original dispatch snapshot once. Cordis does not support
        // replacement request arguments: the desktop retains request.signal,
        // and only the channel receives the coordinator's shorter lifetime.
        decision(next),
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
  const unregister = ctx.on('approval/request', answer, { prepend: true })
  return () => { lifetime.abort(); unregister() }
}

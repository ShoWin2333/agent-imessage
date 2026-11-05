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
  const desktopCopies = new WeakSet<ApprovalRequestEvent>()
  const lifetime = new AbortController()
  const answer: Events['approval/request'] = async function (request, next) {
    if (lifetime.signal.aborted || desktopCopies.has(request) || !ownsSession(request)) return next()
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
    const desktopRequest = { ...request, signal }
    desktopCopies.add(desktopRequest)
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
        // Cordis next() cannot replace its borrowed request. Dispatch a copy
        // through the public scoped waterfall so native UI receives our
        // settlement signal. The marker prevents another coordination round.
        // This intentionally re-enters outer answerer middleware; see the
        // composition limit in the migration guide. Never redispatch the
        // ApprovalService, which alone owns policy checks and the audit pair.
        decision(() => ctx.waterfall(this, 'approval/request', desktopRequest, async (): Promise<ApprovalOutcome> => 'unavailable')),
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

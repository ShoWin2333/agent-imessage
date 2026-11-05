import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import ApprovalService, { setApprovalPolicy, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ChannelInteractions } from '../src/plugin/interactions.js'
import { registerSharedApprovals } from '../src/plugin/shared-approvals.js'
import type { ChannelMessage } from '../src/channels/types.js'

// Run the published DSH browser consumer, including its actual PendingApproval
// lifecycle. The Remote transport and UI registry are in-memory test adapters;
// this does not claim to be a serialized Host/Client or rendered browser test.
interface NativeCard { key: string; answerable: boolean; answer(outcome: 'allowed-once' | 'rejected'): Promise<void> }
let ui!: { inject: string[]; apply(ctx: Context): void }
const require = createRequire(import.meta.url)
vm.runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-approval/client'), 'utf8'), {
  window: { __ModuleLoader__: { load: ({ factory }: { factory: (require: () => object) => typeof ui }) => { ui = factory(() => ({})) } } },
})
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const client = new Context(), ctx = new Context(), cards = new Map<string, NativeCard>()
  const session = Session.create(SessionId('channels-binding-native-ui'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session, ctx }
  let listener!: (this: Context, request: unknown, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
  const services = await client.plugin(c => {
    c.provide('sessions', { scopeOf: () => session.id } as never)
    c.provide('remote', { $on: (_event: string, callback: typeof listener) => { listener = callback; return () => {} } } as never)
    c.provide('uiSession', { registerPendingInteraction: () => (card: NativeCard) => {
      cards.set(card.key, card); return () => cards.delete(card.key)
    } } as never)
    c.provide('slots', { inject: (_name: string, register: () => void) => register(), register: () => () => {}, registerFactory: () => () => {} } as never)
    c.provide('locale', { register: () => () => {}, registerFactory: () => () => {} } as never)
  })
  const clientUi = await client.plugin({ inject: ui.inject, apply: ui.apply })
  const projections = await ctx.plugin(Projections)
  const approval = await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', request => listener.call(client, request, async () => 'unavailable'))
  const broker = new ChannelInteractions(() => true), update = vi.fn(async (_outcome: string) => {})
  const sendApproval = vi.fn(async (_text: string, _token: string) => update)
  const message = { sendApproval } as unknown as ChannelMessage
  const unregister = registerSharedApprovals(ctx, request => request.agent === agent,
    (request, settled) => broker.approval(request, message, settled))
  cleanup.push(async () => { unregister(); broker.cancel(); await clientUi.dispose(); await services.dispose(); await approval.dispose(); await projections.dispose() })
  const request = (signal?: AbortSignal) => ctx.approval.request(Object.freeze({
    agent: agent as never, toolName: 'write', reason: 'Synthetic write', ...(signal ? { signal } : {}),
  }))
  const ready = async () => {
    await vi.waitFor(() => { expect(cards.size).toBe(1); expect(sendApproval).toHaveBeenCalledOnce() })
    await Promise.resolve(); await Promise.resolve()
    return { card: [...cards.values()][0]!, token: sendApproval.mock.calls[0]![1] }
  }
  const decided = () => session.snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)
  return { ctx, session, agent, cards, broker, update, sendApproval, unregister, request, ready, decided }
}

it.each(['allowed-once', 'rejected'] as const)('withdraws the real native desktop card after the channel answers %s', async outcome => {
  const f = await fixture(), caller = new AbortController(), result = f.request(caller.signal)
  const { card, token } = await f.ready()
  f.broker.reply(`/${outcome === 'allowed-once' ? 'approve' : 'deny'} ${token}`)
  expect(await result).toBe(outcome)
  await vi.waitFor(() => expect(f.cards.size).toBe(0))
  expect(card.answerable).toBe(false)
  expect(caller.signal.aborted).toBe(false)
  await expect(card.answer('allowed-once')).rejects.toThrow('already settled')
  expect(() => f.broker.reply(`/approve ${token}`)).toThrow('失效')
  expect(f.decided()).toEqual([outcome])
  expect(f.update).toHaveBeenCalledExactlyOnceWith(outcome)
})

it.each(['allowed-once', 'rejected'] as const)('invalidates channel controls after the native desktop answers %s', async outcome => {
  const f = await fixture(), result = f.request()
  const { card, token } = await f.ready()
  await card.answer(outcome)
  expect(await result).toBe(outcome)
  await vi.waitFor(() => expect(f.cards.size).toBe(0))
  expect(() => f.broker.reply(`/approve ${token}`)).toThrow('失效')
  expect(f.update).toHaveBeenCalledExactlyOnceWith(outcome)
  expect(f.decided()).toEqual([outcome])
})

it('withdraws only the matching native card when concurrent requests settle on different surfaces', async () => {
  const f = await fixture(), first = f.request(), second = f.request()
  await vi.waitFor(() => { expect(f.cards.size).toBe(2); expect(f.sendApproval).toHaveBeenCalledTimes(2) })
  await Promise.resolve(); await Promise.resolve()
  const [firstCard, secondCard] = [...f.cards.values()]
  const firstToken = f.sendApproval.mock.calls[0]![1], secondToken = f.sendApproval.mock.calls[1]![1]
  f.broker.reply(`/approve ${firstToken}`)
  expect(await first).toBe('allowed-once')
  await vi.waitFor(() => expect(f.cards.size).toBe(1))
  expect(firstCard!.answerable).toBe(false)
  expect(secondCard!.answerable).toBe(true)
  await secondCard!.answer('rejected')
  expect(await second).toBe('rejected')
  await vi.waitFor(() => expect(f.cards.size).toBe(0))
  expect(() => f.broker.reply(`/approve ${secondToken}`)).toThrow('失效')
  expect(f.decided()).toEqual(['allowed-once', 'rejected'])
})

it.each(['unload', 'turn-end', 'policy', 'agent-disposed', 'abort'] as const)('withdraws both real approval presentations on %s', async action => {
  const f = await fixture(), caller = new AbortController(), result = f.request(action === 'abort' ? caller.signal : undefined)
  const { card, token } = await f.ready()
  if (action === 'unload') f.unregister()
  if (action === 'abort') caller.abort()
  if (action === 'agent-disposed') f.ctx.emit('agent/disposed', { agent: f.agent } as never)
  if (action === 'policy') {
    setApprovalPolicy(f.session, 'never')
    f.ctx.emit('session/event', f.session, f.session.snapshotEvents().at(-1)!)
  }
  if (action === 'turn-end') {
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.ctx.emit('session/event', f.session, f.session.snapshotEvents().at(-1)!)
  }
  expect(await result).toBe('cancelled')
  await vi.waitFor(() => expect(f.cards.size).toBe(0))
  expect(card.answerable).toBe(false)
  expect(() => f.broker.reply(`/approve ${token}`)).toThrow('失效')
  expect(f.update).toHaveBeenCalledExactlyOnceWith('cancelled')
  expect(f.decided()).toEqual(['cancelled'])
})

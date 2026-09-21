import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { InteractionBroker } from '../src/interactions.js'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'

function agent(id: string): Agent {
  return { id } as Agent
}

function channel(sent: string[]): SpectrumInboundMessage {
  return {
    id: 'provider-message',
    text: 'prompt',
    responding: async callback => callback(),
    send: async text => { sent.push(text) },
    sendFile: async () => {},
    sendVoice: async () => {},
  }
}

describe('fail-closed interaction ownership', () => {
  it('lets unrelated approvals fall through and claims only the exact owned Agent', async () => {
    const selected = agent('selected')
    const other = agent('other')
    const sent: string[] = []
    const dm = channel(sent)
    const broker = new InteractionBroker({
      ownsCurrentTurn: candidate => candidate === selected,
      channelFor: candidate => candidate === selected ? dm : undefined,
      deliveryHealthy: () => true,
    }, 60_000)
    const invoke = broker as unknown as {
      requestApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
    }
    const next = vi.fn(async (): Promise<ApprovalOutcome> => 'rejected')

    await expect(invoke.requestApproval({ agent: other, toolName: 'bash' }, next)).resolves.toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    expect(sent).toEqual([])

    const outcome = invoke.requestApproval({
      agent: selected,
      toolName: 'bash',
      reason: 'Run the requested command',
    }, next)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const id = /Approval required \(([^)]+)\)/u.exec(sent[0] ?? '')?.[1]
    expect(id).toMatch(/^approval-/u)
    expect(sent[0]).not.toContain('provider-message')
    broker.approve(id ?? '')
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('does not claim when delivery is unhealthy or the request was already aborted', async () => {
    const selected = agent('selected')
    const sent: string[] = []
    let healthy = false
    const broker = new InteractionBroker({
      ownsCurrentTurn: () => true,
      channelFor: () => channel(sent),
      deliveryHealthy: () => healthy,
    }, 60_000)
    const invoke = broker as unknown as {
      requestApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
    }
    const next = async (): Promise<ApprovalOutcome> => 'rejected'
    await expect(invoke.requestApproval({ agent: selected, toolName: 'bash' }, next)).resolves.toBe('unavailable')
    healthy = true
    const abort = new AbortController()
    abort.abort()
    await expect(invoke.requestApproval({
      agent: selected, toolName: 'bash', signal: abort.signal,
    }, next)).resolves.toBe('cancelled')
    expect(sent).toEqual([])
  })

  it('formats owned questions and resolves numbered multi-select answers', async () => {
    const selected = agent('selected')
    const sent: string[] = []
    const broker = new InteractionBroker({
      ownsCurrentTurn: () => true,
      channelFor: () => channel(sent),
      deliveryHealthy: () => true,
    }, 60_000)
    const invoke = broker as unknown as {
      requestQuestions(agent: Agent, questions: Array<{
        id: string
        question: string
        options?: Array<{ label: string; description?: string }>
        multiSelect?: boolean
      }>, signal: AbortSignal): Promise<{
        answers: Array<{ id: string; selected: string[]; custom?: string }>
      }>
    }
    const result = invoke.requestQuestions(selected, [{
      id: 'tools',
      question: 'Which tools?',
      options: [{ label: 'Search' }, { label: 'Build' }],
      multiSelect: true,
    }], new AbortController().signal)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    const id = /Question request \(([^)]+)\)/u.exec(sent[0] ?? '')?.[1]
    expect(sent[0]).toContain('1) Search')
    broker.answer(id ?? '', '1,2')
    await expect(result).resolves.toEqual({
      answers: [{ id: 'tools', selected: ['Search', 'Build'] }],
    })
  })

  it('fails closed on timeout even when the delivery promise never settles', async () => {
    vi.useFakeTimers()
    try {
      const selected = agent('selected')
      const stuck: SpectrumInboundMessage = {
        ...channel([]),
        send: async () => new Promise<void>(() => {}),
      }
      const broker = new InteractionBroker({
        ownsCurrentTurn: () => true,
        channelFor: () => stuck,
        deliveryHealthy: () => true,
      }, 1_000)
      const invoke = broker as unknown as {
        requestApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
      }
      const outcome = invoke.requestApproval(
        { agent: selected, toolName: 'bash' },
        async () => 'rejected',
      )
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(outcome).resolves.toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})

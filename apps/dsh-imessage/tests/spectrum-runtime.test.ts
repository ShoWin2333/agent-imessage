import { describe, expect, it, vi } from 'vitest'
import {
  acceptsInboundMessage,
  SpectrumSupervisor,
  type SpectrumConnection,
  type SpectrumConnectionConfig,
} from '../src/spectrum-runtime.js'

const connectionConfig: SpectrumConnectionConfig = {
  projectId: 'project',
  projectSecret: 'secret',
  senderPhoneNumber: '+14155552671',
  assignedPhoneNumber: '+14155550000',
}

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    platform: 'imessage',
    direction: 'inbound',
    content: { type: 'text', text: 'hello' },
    sender: { address: '+14155552671', service: 'iMessage' },
    space: { type: 'dm', phone: '+14155550000' },
    ...overrides,
  }
}

function heldConnection(stop = vi.fn(async () => {})): SpectrumConnection {
  return {
    messages: (async function* () {
      await new Promise<void>(() => {})
    })(),
    stop,
  }
}

describe('Spectrum ingress policy', () => {
  it('accepts only the configured text iMessage DM route', () => {
    expect(acceptsInboundMessage(inbound(), connectionConfig)).toBe(true)
    expect(acceptsInboundMessage(inbound({ sender: { id: '+14155552671' } }), connectionConfig)).toBe(true)
    expect(acceptsInboundMessage(inbound({ sender: { address: '+14155559999' } }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({ space: { type: 'dm', phone: '+14155551111' } }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({ platform: 'sms' }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({ sender: { address: '+14155552671', service: 'SMS' } }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({ space: { type: 'group', phone: '+14155550000' } }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({ content: { type: 'attachment', url: 'private' } }), connectionConfig)).toBe(false)
  })

  it('accepts Spectrum shared-line records only for the configured sender route', () => {
    const shared = { type: 'dm', phone: 'shared' }
    expect(acceptsInboundMessage(inbound({ space: shared }), connectionConfig)).toBe(true)
    expect(acceptsInboundMessage(inbound({
      sender: { address: '+14155559999', service: 'iMessage' },
      space: shared,
    }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({
      sender: { address: '+14155552671', service: 'SMS' },
      space: shared,
    }), connectionConfig)).toBe(false)
    expect(acceptsInboundMessage(inbound({
      space: { type: 'group', phone: 'shared' },
    }), connectionConfig)).toBe(false)
  })
})

describe('SpectrumSupervisor', () => {
  it('serializes replacement and stops only local connections', async () => {
    const firstStop = vi.fn(async () => {})
    const secondStop = vi.fn(async () => {})
    const factory = vi.fn()
      .mockResolvedValueOnce(heldConnection(firstStop))
      .mockResolvedValueOnce(heldConnection(secondStop))
    const states: string[] = []
    const supervisor = new SpectrumSupervisor(factory, {
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      onState: state => { states.push(state.phase) },
      onMessage: async () => {},
    })

    await supervisor.restart(connectionConfig)
    await supervisor.restart({ ...connectionConfig, senderPhoneNumber: '+442071838750' })
    expect(firstStop).toHaveBeenCalledOnce()
    expect(factory).toHaveBeenNthCalledWith(2, expect.objectContaining({ senderPhoneNumber: '+442071838750' }))
    await supervisor.stop()
    expect(secondStop).toHaveBeenCalledOnce()
    expect(supervisor.state).toEqual({ phase: 'stopped' })
    expect(states).toContain('listening')
  })

  it('keeps a working listener alive until a prepared replacement is ready', async () => {
    const oldStop = vi.fn(async () => {})
    const replacementStop = vi.fn(async () => {})
    const factory = vi.fn()
      .mockResolvedValueOnce(heldConnection(oldStop))
      .mockRejectedValueOnce(new Error('replacement unavailable'))
      .mockResolvedValueOnce(heldConnection(replacementStop))
    const supervisor = new SpectrumSupervisor(factory, {
      reconnectMinMs: 100,
      reconnectMaxMs: 1_000,
      onState: () => {},
      onMessage: async () => {},
    })
    await supervisor.restart(connectionConfig)

    await expect(supervisor.prepare({
      ...connectionConfig,
      senderPhoneNumber: '+442071838750',
    })).rejects.toThrow('replacement unavailable')
    expect(oldStop).not.toHaveBeenCalled()
    expect(supervisor.state.phase).toBe('listening')

    const target = { ...connectionConfig, senderPhoneNumber: '+442071838750' }
    const prepared = await supervisor.prepare(target)
    await supervisor.activate(target, prepared)
    expect(oldStop).toHaveBeenCalledOnce()
    expect(supervisor.state.phase).toBe('listening')
    await supervisor.stop()
    expect(replacementStop).toHaveBeenCalledOnce()
  })

  it('reconnects with bounded exponential backoff and jitter', async () => {
    vi.useFakeTimers()
    try {
      const factory = vi.fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce(heldConnection())
      const supervisor = new SpectrumSupervisor(factory, {
        reconnectMinMs: 100,
        reconnectMaxMs: 1_000,
        random: () => 0.5,
        now: () => Date.now(),
        onState: () => {},
        onMessage: async () => {},
      })
      await supervisor.restart(connectionConfig)
      expect(supervisor.state).toMatchObject({ phase: 'retrying', attempt: 1 })
      await vi.advanceTimersByTimeAsync(100)
      expect(factory).toHaveBeenCalledTimes(2)
      expect(supervisor.state.phase).toBe('listening')
      await supervisor.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

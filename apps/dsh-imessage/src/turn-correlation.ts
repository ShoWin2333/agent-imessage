import type { Agent } from '@deepseek-ai/dsh-agent'
import { PluginError } from './errors.js'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'

interface TurnWait {
  agent: Agent
  messageId: string
  channel: SpectrumInboundMessage
  turn?: number
  lastText?: string
  resolve(value: string | undefined): void
  reject(error: Error): void
}

/** Exact UserMessage.id → claimed turn ownership used to isolate browser activity. */
export class TurnCorrelation {
  private readonly waitsByMessage = new Map<string, TurnWait>()
  private readonly waitsByTurn = new Map<string, TurnWait>()
  private readonly ownedTurn = new WeakMap<Agent, TurnWait>()

  /** Register one plugin-authored message before it enters the Agent inbox. */
  begin(agent: Agent, messageId: string, channel: SpectrumInboundMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      this.waitsByMessage.set(messageId, { agent, messageId, channel, resolve, reject })
    })
  }

  /** Reject a message that could not be submitted after registration. */
  failUnclaimed(agent: Agent, messageId: string, error: Error): void {
    const wait = this.waitsByMessage.get(messageId)
    if (wait === undefined || wait.agent !== agent) return
    this.waitsByMessage.delete(messageId)
    wait.reject(error)
  }

  /** Bind a turn only when DSH claims this plugin's exact UserMessage id. */
  claim(agent: Agent, messageId: string, turn: number): void {
    const wait = this.waitsByMessage.get(messageId)
    if (wait === undefined || wait.agent !== agent) return
    this.waitsByMessage.delete(messageId)
    wait.turn = turn
    this.waitsByTurn.set(turnKey(agent.id, turn), wait)
    this.ownedTurn.set(agent, wait)
  }

  /** Reject one plugin message DSH discarded before assigning a turn. */
  discard(agent: Agent, messageId: string): void {
    this.failUnclaimed(
      agent,
      messageId,
      new PluginError('runtime-failed', 'DSH discarded the queued iMessage prompt.'),
    )
  }

  /** Retain only the latest final assistant message for the exact owned turn. */
  assistant(sessionId: string, turn: number, text: string): void {
    const wait = this.waitsByTurn.get(turnKey(sessionId, turn))
    if (wait !== undefined && text.length > 0) wait.lastText = text
  }

  /** Resolve the final text for the exact owned turn; unrelated turns fall through. */
  end(sessionId: string, turn: number): void {
    const key = turnKey(sessionId, turn)
    const wait = this.waitsByTurn.get(key)
    if (wait === undefined) return
    this.waitsByTurn.delete(key)
    if (this.ownedTurn.get(wait.agent) === wait) this.ownedTurn.delete(wait.agent)
    wait.resolve(wait.lastText)
  }

  /** Whether this Agent's currently correlated turn belongs to iMessage. */
  owns(agent: Agent): boolean {
    return this.ownedTurn.has(agent)
  }

  /** Return the DM channel for this Agent's exact owned turn. */
  channelFor(agent: Agent): SpectrumInboundMessage | undefined {
    return this.ownedTurn.get(agent)?.channel
  }

  /** Reject and return plugin-authored messages still waiting in an Agent inbox. */
  cancelUnclaimed(agent: Agent, error: Error): string[] {
    const messageIds: string[] = []
    for (const [messageId, wait] of this.waitsByMessage) {
      if (wait.agent !== agent) continue
      this.waitsByMessage.delete(messageId)
      messageIds.push(messageId)
      wait.reject(error)
    }
    return messageIds
  }

  /** Reject every pending message/turn owned by a disposed Agent. */
  disposeAgent(agent: Agent): void {
    for (const [messageId, wait] of this.waitsByMessage) {
      if (wait.agent !== agent) continue
      this.waitsByMessage.delete(messageId)
      wait.reject(new PluginError(
        'runtime-failed',
        'The selected DSH session stopped before claiming the prompt.',
      ))
    }
    for (const [key, wait] of this.waitsByTurn) {
      if (wait.agent !== agent) continue
      this.waitsByTurn.delete(key)
      if (this.ownedTurn.get(agent) === wait) this.ownedTurn.delete(agent)
      wait.reject(new PluginError(
        'runtime-failed',
        'The active DSH session stopped before answering.',
      ))
    }
  }

  /** Reject every pending wait during plugin teardown. */
  close(): void {
    const waits = new Set([...this.waitsByMessage.values(), ...this.waitsByTurn.values()])
    this.waitsByMessage.clear()
    this.waitsByTurn.clear()
    for (const wait of waits) {
      this.ownedTurn.delete(wait.agent)
      wait.reject(new Error('The iMessage router stopped.'))
    }
  }
}

function turnKey(sessionId: string, turn: number): string {
  return `${sessionId}\u0000${turn}`
}

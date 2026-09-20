import { PluginError } from '../transport-error.js'
import type { RuntimeView } from '../types.js'
import type { ChannelConnection, ChannelFactory, ChannelMessage } from './types.js'

/** Supervisor callbacks. */
export interface ChannelSupervisorOptions {
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs: number
  /** Called for every public runtime transition. */
  onState(state: RuntimeView): void
  /** Called for every accepted inbound text message. */
  onMessage(message: ChannelMessage): Promise<void>
  /** Random source used for reconnect jitter. */
  random?: () => number
  /** Clock used for public state timestamps. */
  now?: () => number
}

/** Serialized Channel stop/start lifecycle with bounded exponential reconnect. */
export class ChannelSupervisor<Config extends object> {
  private readonly random: () => number
  private readonly now: () => number
  private desired: Config | undefined
  private connection: ChannelConnection | undefined
  private operation = Promise.resolve()
  private generation = 0
  private reconnectAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stateValue: RuntimeView = { phase: 'stopped' }

  /** Construct one listener supervisor. */
  constructor(
    private readonly factory: ChannelFactory<Config>,
    private readonly options: ChannelSupervisorOptions,
  ) {
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
  }

  /** Current public listener health. */
  get state(): RuntimeView {
    return this.stateValue
  }

  /** Whether interaction delivery is healthy enough to claim DSH prompts. */
  get healthy(): boolean {
    return this.stateValue.phase === 'listening'
  }

  async scheduledMessage(id: string, text: string): Promise<ChannelMessage> {
    const connection = this.connection
    if (!this.healthy || !connection?.scheduledMessage) throw new Error('Channel cannot deliver scheduled messages')
    const message = await connection.scheduledMessage(id, text)
    if (connection !== this.connection || !this.healthy) throw new Error('Channel changed')
    return message
  }

  /** Open and validate a replacement connection without disturbing the active listener. */
  prepare(config: Config): Promise<ChannelConnection> {
    return this.factory({ ...config })
  }

  /** Atomically adopt a prepared listener, then release the previous one. */
  activate(config: Config, connection: ChannelConnection): Promise<void> {
    return this.enqueue(async () => {
      this.desired = { ...config }
      this.reconnectAttempt = 0
      if (this.retryTimer !== undefined) {
        clearTimeout(this.retryTimer)
        this.retryTimer = undefined
      }
      const previous = this.connection
      const generation = ++this.generation
      this.connection = connection
      this.publish({ phase: 'listening', connectedAt: this.now() })
      void this.consume(connection, generation)
      if (previous !== undefined && previous !== connection) {
        try {
          await previous.stop()
        } catch {
          // The generation gate already prevents the previous stream from routing.
        }
      }
    })
  }

  /** Atomically replace the desired configuration and restart the listener. */
  restart(config: Config): Promise<void> {
    this.desired = { ...config }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Retry the current configuration immediately. */
  retry(): Promise<void> {
    if (this.desired === undefined) {
      return Promise.reject(new PluginError('runtime-failed', 'Provision a phone number before starting channel.'))
    }
    this.reconnectAttempt = 0
    return this.enqueue(async () => {
      await this.stopCurrent(false)
      await this.startCurrent()
    })
  }

  /** Stop local routing while preserving Photon cloud resources. */
  stop(): Promise<void> {
    this.desired = undefined
    return this.enqueue(async () => {
      await this.stopCurrent(true)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operation.then(operation, operation)
    this.operation = result.catch(() => {})
    return result
  }

  private async startCurrent(): Promise<void> {
    const config = this.desired
    if (config === undefined) {
      this.publish({ phase: 'stopped' })
      return
    }
    const generation = ++this.generation
    this.publish({ phase: 'starting' })
    try {
      const connection = await this.factory(config)
      if (generation !== this.generation || this.desired === undefined) {
        await connection.stop()
        return
      }
      this.connection = connection
      this.reconnectAttempt = 0
      this.publish({ phase: 'listening', connectedAt: this.now() })
      void this.consume(connection, generation)
    } catch (error) {
      if (generation !== this.generation || this.desired === undefined) return
      this.scheduleReconnect(error)
    }
  }

  private async consume(connection: ChannelConnection, generation: number): Promise<void> {
    try {
      for await (const message of connection.messages) {
        if (generation !== this.generation || connection !== this.connection) return
        try {
          await this.options.onMessage(message)
        } catch {
          // A DSH turn or outbound send failure must not terminate Channel's receive stream.
        }
      }
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, new Error('Channel message stream ended'))
      }
    } catch (error) {
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, error)
      }
    }
  }

  private async retireAndReconnect(
    connection: ChannelConnection,
    generation: number,
    error: unknown,
  ): Promise<void> {
    this.connection = undefined
    try {
      await connection.stop()
    } catch {
      // The failed stream is already fenced by identity and generation.
    }
    if (generation === this.generation && this.desired !== undefined) this.scheduleReconnect(error)
  }

  private scheduleReconnect(_error: unknown): void {
    if (this.desired === undefined) return
    const attempt = ++this.reconnectAttempt
    const exponential = Math.min(
      this.options.reconnectMaxMs,
      this.options.reconnectMinMs * 2 ** Math.min(attempt - 1, 20),
    )
    const jittered = Math.max(1, Math.round(exponential * (0.75 + this.random() * 0.5)))
    const retryAt = this.now() + jittered
    this.publish({ phase: 'retrying', attempt, retryAt })
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.enqueue(() => this.startCurrent()).catch(() => {
        this.publish({
          phase: 'failed',
          error: { code: 'runtime-failed', message: 'The channel listener could not restart.' },
        })
      })
    }, jittered)
  }

  private async stopCurrent(clearState: boolean): Promise<void> {
    this.generation += 1
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
    }
    const connection = this.connection
    this.connection = undefined
    if (connection !== undefined) {
      try {
        await connection.stop()
      } catch {
        // Teardown remains best-effort; the generation gate prevents further routing.
      }
    }
    if (clearState) this.publish({ phase: 'stopped' })
  }

  private publish(state: RuntimeView): void {
    this.stateValue = state
    this.options.onState(state)
  }
}

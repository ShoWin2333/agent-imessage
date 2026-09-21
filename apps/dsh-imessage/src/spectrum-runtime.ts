import {
  Spectrum,
  attachment,
  voice,
  type PlatformProviderConfig,
  type SpectrumInstance,
} from '@spectrum-ts/core'
import { imessage } from '@spectrum-ts/imessage'
import { extname } from 'node:path'
import { PluginError } from './errors.js'
import type { OutboundMediaPayload } from './outbound-media.js'
import type { RuntimeView } from './types.js'

/** Recipient marker emitted by Spectrum 12.7 for project-scoped shared lines. */
const SPECTRUM_SHARED_PHONE = 'shared'

/** Credentials required to discover and connect the project's hosted line. */
export interface SpectrumConnectionConfig {
  /** Photon project id. */
  projectId: string
  /** Host-only Spectrum project secret. */
  projectSecret: string
  /** Authorized originating E.164 number. */
  senderPhoneNumber: string
  /** Assigned hosted recipient E.164 number. */
  assignedPhoneNumber: string
}

/** Text-only inbound message accepted by the security filter. */
export interface SpectrumInboundMessage {
  /** Durable provider message id. */
  id: string
  /** Plain inbound text. */
  text: string
  /** Run work while Spectrum maintains typing state. */
  responding<T>(callback: () => Promise<T>): Promise<T>
  /** Send one plain-text iMessage to the same DM. */
  send(text: string): Promise<void>
  /** Send one file attachment to the same DM. */
  sendFile(media: OutboundMediaPayload): Promise<void>
  /** Send one native audio message to the same DM. */
  sendVoice(media: OutboundMediaPayload): Promise<void>
}

/** Running Spectrum connection behind an injectable adapter seam. */
export interface SpectrumConnection {
  /** Accepted inbound text-only messages. */
  messages: AsyncIterable<SpectrumInboundMessage>
  /** Stop and release provider resources. */
  stop(): Promise<void>
}

/** Injectable Spectrum connection factory. */
export type SpectrumConnectionFactory = (config: SpectrumConnectionConfig) => Promise<SpectrumConnection>

/** Supervisor callbacks. */
export interface SpectrumSupervisorOptions {
  /** Initial reconnect delay in milliseconds. */
  reconnectMinMs: number
  /** Maximum reconnect delay in milliseconds. */
  reconnectMaxMs: number
  /** Called for every public runtime transition. */
  onState(state: RuntimeView): void
  /** Called for every accepted inbound text message. */
  onMessage(message: SpectrumInboundMessage): Promise<void>
  /** Random source used for reconnect jitter. */
  random?: () => number
  /** Clock used for public state timestamps. */
  now?: () => number
}

/** Serialized Spectrum stop/start lifecycle with bounded exponential reconnect. */
export class SpectrumSupervisor {
  private readonly random: () => number
  private readonly now: () => number
  private desired: SpectrumConnectionConfig | undefined
  private connection: SpectrumConnection | undefined
  private operation = Promise.resolve()
  private generation = 0
  private reconnectAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stateValue: RuntimeView = { phase: 'stopped' }

  /** Construct one listener supervisor. */
  constructor(
    private readonly factory: SpectrumConnectionFactory,
    private readonly options: SpectrumSupervisorOptions,
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

  /** Open and validate a replacement connection without disturbing the active listener. */
  prepare(config: SpectrumConnectionConfig): Promise<SpectrumConnection> {
    return this.factory({ ...config })
  }

  /** Atomically adopt a prepared listener, then release the previous one. */
  activate(config: SpectrumConnectionConfig, connection: SpectrumConnection): Promise<void> {
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
  restart(config: SpectrumConnectionConfig): Promise<void> {
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
      return Promise.reject(new PluginError('runtime-failed', 'Provision a phone number before starting iMessage.'))
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

  private async consume(connection: SpectrumConnection, generation: number): Promise<void> {
    try {
      for await (const message of connection.messages) {
        if (generation !== this.generation || connection !== this.connection) return
        try {
          await this.options.onMessage(message)
        } catch {
          // A DSH turn or outbound send failure must not terminate Spectrum's receive stream.
        }
      }
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, new Error('Spectrum message stream ended'))
      }
    } catch (error) {
      if (generation === this.generation && connection === this.connection && this.desired !== undefined) {
        await this.retireAndReconnect(connection, generation, error)
      }
    }
  }

  private async retireAndReconnect(
    connection: SpectrumConnection,
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
          error: { code: 'runtime-failed', message: 'The iMessage listener could not restart.' },
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

/** Build a production Spectrum 12.7 connection with hosted-line discovery. */
export const createSpectrumConnection: SpectrumConnectionFactory = async config => {
  // Spectrum 12.7.0's separately-published iMessage declaration loses its
  // PlatformDef constraint through an Omit. Keep that compatibility cast at
  // this single package boundary; runtime values follow the documented API.
  const provider = (imessage.config as unknown as () => PlatformProviderConfig)()
  const app = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [provider],
    telemetry: false,
    options: { logLevel: 'warn', flattenGroups: true },
  })
  return adaptSpectrum(app, config)
}

/** Pure inbound policy used by the production adapter and replay tests. */
export function acceptsInboundMessage(
  raw: {
    id?: unknown
    platform?: unknown
    direction?: unknown
    content?: unknown
    sender?: unknown
    space?: unknown
  },
  config: Pick<SpectrumConnectionConfig, 'senderPhoneNumber' | 'assignedPhoneNumber'>,
): raw is {
  id: string
  platform: 'imessage'
  direction: 'inbound'
  content: { type: 'text'; text: string }
  sender: { id?: string; address?: string; service?: string }
  space: { type: 'dm'; phone: string }
} {
  if (raw.platform !== 'imessage' || raw.direction !== 'inbound' || typeof raw.id !== 'string') return false
  if (!raw.content || typeof raw.content !== 'object') return false
  const content = raw.content as Record<string, unknown>
  if (content['type'] !== 'text' || typeof content['text'] !== 'string') return false
  if (!raw.sender || typeof raw.sender !== 'object') return false
  const sender = raw.sender as Record<string, unknown>
  const address = typeof sender['address'] === 'string'
    ? sender['address']
    : typeof sender['id'] === 'string' ? sender['id'] : undefined
  if (address !== config.senderPhoneNumber) return false
  if (sender['service'] !== undefined && sender['service'] !== 'iMessage') return false
  if (!raw.space || typeof raw.space !== 'object') return false
  const space = raw.space as Record<string, unknown>
  if (space['type'] !== 'dm') return false

  // Spectrum cannot expose the recipient on shared-token inbound records and
  // deliberately tags their project-scoped route as "shared". The exact sender
  // and service checks above remain mandatory; dedicated routes still require
  // the configured assigned number.
  const routedPhone = space['phone']
  return routedPhone === config.assignedPhoneNumber || routedPhone === SPECTRUM_SHARED_PHONE
}

function adaptSpectrum(
  app: SpectrumInstance,
  config: SpectrumConnectionConfig,
): SpectrumConnection {
  return {
    messages: mapMessages(app, config),
    stop: () => app.stop(),
  }
}

async function* mapMessages(
  app: SpectrumInstance,
  config: SpectrumConnectionConfig,
): AsyncIterable<SpectrumInboundMessage> {
  for await (const [space, message] of app.messages) {
    if (!acceptsInboundMessage(message, config)) continue
    yield {
      id: message.id,
      text: message.content.text,
      responding: callback => space.responding(callback),
      send: async (value) => {
        await space.send(value)
      },
      sendFile: async (media) => {
        await space.send(attachmentForOutbound(media))
      },
      sendVoice: async (media) => {
        await space.send(voiceForOutbound(media))
      },
    }
  }
}

/** Map outbound file bytes to Spectrum's attachment builder (adapter-local). */
export function attachmentForOutbound(media: OutboundMediaPayload) {
  return attachment(media.bytes, { name: media.name, mimeType: media.mimeType })
}

/** Map outbound audio bytes to Spectrum's voice builder so the native audio flag is set. */
export function voiceForOutbound(media: OutboundMediaPayload) {
  const extension = extname(media.name)
  const stem = extension.length > 0 ? media.name.slice(0, -extension.length) : media.name

  // Spectrum converts non-M4A audio before upload but preserves this name.
  // Keep the uploaded extension consistent with the converted container so
  // Messages can read its duration and play it as a native voice message.
  return voice(media.bytes, { name: `${stem}.m4a`, mimeType: media.mimeType })
}

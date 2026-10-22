import type { OutboundMediaPayload } from '../media.js'
import type { RuntimeView } from '../types.js'

/** Text-only inbound message accepted by the security filter. */
export interface ChannelMessage {
  /** False when the provider cannot deliver native voice messages. */
  nativeVoice?: boolean
  origin?: 'desktop'
  /** Durable provider message id. */
  id: string
  /** Plain inbound text. */
  text: string
  /** Run work while the channel maintains typing state. */
  responding<T>(callback: () => Promise<T>): Promise<T>
  /** Send one plain-text message to the same DM. */
  send(text: string): Promise<void>
  /** Send one file attachment to the same DM. */
  sendFile(media: OutboundMediaPayload): Promise<void>
  /** Send one native audio message to the same DM. */
  sendVoice(media: OutboundMediaPayload): Promise<void>
}

export interface ChannelConnection {
  scheduledMessage?(id: string, text: string): Promise<ChannelMessage>
  messages: AsyncIterable<ChannelMessage>
  stop(): Promise<void>
}
export type ChannelFactory<Config> = (config: Config) => Promise<ChannelConnection>
export interface ChannelAdapter {
  scheduledMessage?(id: string, text: string): Promise<ChannelMessage>
  readonly state: RuntimeView
  start(): Promise<void>
  stop(): Promise<void>
}

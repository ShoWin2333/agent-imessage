import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { OutboundMediaPayload } from '../media.js'
import type { RuntimeView } from '../types.js'

/** Text-only inbound message accepted by the security filter. */
export interface ChannelMessage {
  /** False when the provider cannot deliver native voice messages. */
  nativeVoice?: boolean
  /** Check the actual payload before native delivery; incompatible audio must use file delivery. */
  supportsNativeVoice?(media: OutboundMediaPayload): boolean
  origin?: 'desktop'
  /** Durable provider message id. */
  id: string
  /** Plain inbound text. */
  text: string
  /** Run work while the channel maintains typing state. */
  responding<T>(callback: () => Promise<T>): Promise<T>
  /** Send one plain-text message to the same DM. */
  send(text: string): Promise<void>
  /** Show approve/deny controls for a single pending request in the same DM. */
  sendApproval?(text: string, token: string, signal: AbortSignal): Promise<void | ((outcome: ApprovalOutcome) => Promise<void>)>
  /** Send one image to the same DM, using provider photo delivery when available.
   * Cancellation is best effort once the provider has accepted an upload; never retry ambiguous delivery.
   */
  sendImage?(media: OutboundMediaPayload, signal?: AbortSignal): Promise<void>
  /** Send one file attachment to the same DM. */
  sendFile(media: OutboundMediaPayload, signal?: AbortSignal): Promise<void>
  /** Send one native audio message to the same DM. */
  sendVoice(media: OutboundMediaPayload, signal?: AbortSignal): Promise<void>
}

export interface ChannelConnection {
  scheduledMessage?(id: string, text: string): Promise<ChannelMessage>
  messages: AsyncIterable<ChannelMessage>
  stop(): Promise<void>
}
export type ChannelFactory<Config> = (config: Config) => Promise<ChannelConnection>
export interface ChannelAdapter {
  /** Deliver shared desktop approvals only to the verified owner's private chat. */
  readonly approvalMessage?: (() => Promise<ChannelMessage>) | undefined
  scheduledMessage?(id: string, text: string): Promise<ChannelMessage>
  readonly state: RuntimeView
  start(): Promise<void>
  stop(): Promise<void>
}

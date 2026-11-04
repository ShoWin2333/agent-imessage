import type { OutboundMediaPayload } from '../media.js'
import type { InteractionScope } from './interaction-types.js'

export type MediaKind = 'image' | 'file' | 'voice'
export interface MediaDeliveryResult {
  delivery: 'sent' | 'uncertain'
  name: string
  bytes: number
  mode: MediaKind
  reason?: string
}
export interface MediaInteraction extends InteractionScope {
  callId: string
  kind: MediaKind
  media: OutboundMediaPayload
}
export type MediaHandler = (request: MediaInteraction) => Promise<MediaDeliveryResult>
export interface StoredMediaReceipt {
  callId: string
  name: string
  bytes: number
  mode: MediaKind
  delivery: 'sending' | 'sent' | 'uncertain'
}

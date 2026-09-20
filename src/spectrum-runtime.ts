import {
  Spectrum,
  attachment,
  voice,
  type PlatformProviderConfig,
  type SpectrumInstance,
  type Space,
} from '@spectrum-ts/core'
import { imessage } from '@spectrum-ts/imessage'
import { extname } from 'node:path'
import { ChannelSupervisor, type ChannelSupervisorOptions } from './channels/supervisor.js'
import type { ChannelMessage } from './channels/types.js'
import type { OutboundMediaPayload } from './media.js'

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

export type SpectrumInboundMessage = ChannelMessage

/** Running Spectrum connection behind an injectable adapter seam. */
export interface SpectrumConnection {
  /** Accepted inbound text-only messages. */
  scheduledMessage?(id: string, text: string): Promise<ChannelMessage>
  messages: AsyncIterable<SpectrumInboundMessage>
  /** Stop and release provider resources. */
  stop(): Promise<void>
}

/** Injectable Spectrum connection factory. */
export type SpectrumConnectionFactory = (config: SpectrumConnectionConfig) => Promise<SpectrumConnection>

/** Backwards-compatible public supervisor for existing iMessage consumers. */
export class SpectrumSupervisor extends ChannelSupervisor<SpectrumConnectionConfig> {}
export type SpectrumSupervisorOptions = ChannelSupervisorOptions

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
    scheduledMessage: async (id, text) => {
      // Same package declaration workaround as provider config, isolated at this boundary.
      const platform = (imessage as unknown as (app: SpectrumInstance) => {space:{create(user:string,params:{phone:string}):Promise<Space & {type:string;phone:string}>}})(app)
      const space = await platform.space.create(config.senderPhoneNumber,{phone:config.assignedPhoneNumber})
      if (space.type !== 'dm' || ![config.assignedPhoneNumber,SPECTRUM_SHARED_PHONE].includes(space.phone)) throw new Error('Outbound scope mismatch')
      return {id,text,responding:callback=>space.responding(callback),send:async value=>{await space.send(value)},
        sendFile:async media=>{await space.send(attachmentForOutbound(media))},sendVoice:async media=>{await space.send(voiceForOutbound(media))}}
    },
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

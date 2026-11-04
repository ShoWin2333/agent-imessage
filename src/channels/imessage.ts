import { SpectrumSupervisor, createSpectrumConnection, type SpectrumConnectionFactory, type SpectrumConnectionConfig } from '../spectrum-runtime.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import type { RuntimeView } from '../types.js'

/** Spectrum attachments preserve image MIME metadata; native voice stays on its own path. */
function withImageTransport(message: ChannelMessage): ChannelMessage {
  return {...message,
    sendImage: async (media, signal) => {
      signal?.throwIfAborted()
      await (message.sendImage ? message.sendImage(media,signal) : message.sendFile(media,signal))
    },
    sendFile: async (media, signal) => {signal?.throwIfAborted(); await message.sendFile(media,signal)},
    sendVoice: async (media, signal) => {signal?.throwIfAborted(); await message.sendVoice(media,signal)},
  }
}

export class IMessageAdapter implements ChannelAdapter {
  private readonly supervisor: SpectrumSupervisor
  constructor(private readonly config: SpectrumConnectionConfig, onMessage: (message: ChannelMessage) => Promise<void>, onState: (state: RuntimeView) => void, factory: SpectrumConnectionFactory = createSpectrumConnection) {
    this.supervisor = new SpectrumSupervisor(factory,{reconnectMinMs:1000,reconnectMaxMs:60_000,
      onMessage:message=>onMessage(withImageTransport(message)),onState})
  }
  async scheduledMessage(id: string, text: string) { return withImageTransport(await this.supervisor.scheduledMessage(id, text)) }
  get state() { return this.supervisor.state }
  start() { return this.supervisor.restart(this.config) }
  stop() { return this.supervisor.stop() }
}

import { SpectrumSupervisor, createSpectrumConnection, type SpectrumConnectionFactory, type SpectrumConnectionConfig } from '../spectrum-runtime.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import type { RuntimeView } from '../types.js'

export class IMessageAdapter implements ChannelAdapter {
  private readonly supervisor: SpectrumSupervisor
  constructor(private readonly config: SpectrumConnectionConfig, onMessage: (message: ChannelMessage) => Promise<void>, onState: (state: RuntimeView) => void, factory: SpectrumConnectionFactory = createSpectrumConnection) {
    this.supervisor = new SpectrumSupervisor(factory,{reconnectMinMs:1000,reconnectMaxMs:60_000,onMessage,onState})
  }
  get state() { return this.supervisor.state }
  start() { return this.supervisor.restart(this.config) }
  stop() { return this.supervisor.stop() }
}

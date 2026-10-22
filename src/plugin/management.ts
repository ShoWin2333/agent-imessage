import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Binding } from './index.js'

declare module '@deepseek-ai/cordis' { interface Context { channelsController: ChannelsController } }

export interface BindingStatus { id: string; phase: string; error?: string }
export interface BindingResource { close(): Promise<void> }
export class ActivationCleanupError extends Error { constructor(readonly resource: BindingResource) { super('Binding cleanup incomplete') } }
type Factory = (binding: Binding, signal: AbortSignal, state: (phase: string) => void) => Promise<BindingResource>
const fingerprint = (binding: Binding) => JSON.stringify(binding)
/** Transport activation only. Native DSH continues to own execution and sessions. */
export class ChannelManager {
  private desired: Binding[] = []
  private live = new Map<string, { fingerprint: string; abort: AbortController; resource?: BindingResource }>()
  private states = new Map<string, BindingStatus>()
  private queue = Promise.resolve()
  private closed = false
  private generation = 0
  private configError: string | undefined
  constructor(private readonly start: Factory) {}
  rejectConfiguration(): void { this.configError = '配置无效，当前连接保留；请修正配置后重新保存。' }
  status(): { bindings: BindingStatus[]; configError?: string } { return { ...(this.configError ? {configError:this.configError} : {}), bindings: this.desired.map(b => ({ ...(this.states.get(b.id) ?? { id: b.id, phase: 'stopped' }) })) } }
  update(bindings: Binding[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Channel manager is closed'))
    this.configError = undefined
    this.desired = structuredClone(bindings)
    this.generation += 1
    for (const [id, item] of this.live) {
      const next = bindings.find(b => b.id === id && b.enabled)
      if (!next || fingerprint(next) !== item.fingerprint) item.abort.abort()
    }
    this.queue = this.queue.catch(() => {}).then(() => this.reconcile())
    return this.queue
  }
  private async reconcile(): Promise<void> {
    if (this.closed) return
    for (const [id, item] of this.live) if (item.abort.signal.aborted) {
      this.states.set(id, { id, phase: 'stopping' })
      try { await item.resource?.close() } catch {
        this.states.set(id, { id, phase: 'error', error: '渠道停止未完成；请停用插件后检查。' })
        // Never start a competing consumer after an uncertain teardown.
        throw new Error('Channel teardown incomplete')
      }
      this.live.delete(id)
    }
    const generation = this.generation
    for (const binding of this.desired) {
      if (this.closed || generation !== this.generation) return
      if (!binding.enabled) { this.states.set(binding.id, { id: binding.id, phase: 'stopped' }); continue }
      if (this.live.has(binding.id)) continue
      const item: { fingerprint: string; abort: AbortController; resource?: BindingResource } = { fingerprint: fingerprint(binding), abort: new AbortController() }
      this.live.set(binding.id, item)
      this.states.set(binding.id, { id: binding.id, phase: 'starting' })
      try {
        const resource = await this.start(binding, item.abort.signal, phase => {
          if (!this.closed && !item.abort.signal.aborted && this.live.get(binding.id) === item) this.states.set(binding.id, { id: binding.id, phase })
        })
        item.resource = resource
        if (item.abort.signal.aborted || this.closed) await resource.close()
      } catch (error) {
        if (item.resource || error instanceof ActivationCleanupError) {
          if (error instanceof ActivationCleanupError) item.resource = error.resource
          item.abort.abort()
          this.states.set(binding.id, {id:binding.id,phase:'error',error:'渠道停止未完成；为防止重复消费者，已阻止重新连接。'})
          throw new Error('Channel teardown incomplete')
        }
        if (!item.abort.signal.aborted && !this.closed) this.states.set(binding.id, { id: binding.id, phase: 'error', error: '渠道未连接；请检查目录、宿主模型、权限预设和凭据引用。' })
        this.live.delete(binding.id)
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const item of this.live.values()) item.abort.abort()
    await this.queue.catch(() => {})
    const results = await Promise.allSettled([...this.live.values()].map(item => item.resource?.close()))
    this.live.clear()
    if (results.some(r => r.status === 'rejected')) throw new Error('Channel teardown incomplete')
  }
}

/** Read-only status exported through the host's native Remote gateway. */
export class ChannelsController extends TypertRemoteService {
  constructor(ctx: Context, private readonly manager: ChannelManager) { super(ctx, 'channelsController', { namespace: 'channels' }) }
  @Remote('status')
  status(): { bindings: BindingStatus[]; configError?: string } { return this.manager.status() }
}

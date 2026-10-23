import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Binding } from './index.js'

declare module '@deepseek-ai/cordis' { interface Context { channelsController: ChannelsController } }

export type BindingErrorCode = 'activation-failed' | 'teardown-incomplete' | 'config-invalid' | 'workspace-missing' | 'preset-missing' | 'model-missing' | 'credential-missing' | 'session-mismatch'
export interface BindingStatus { id: string; phase: string; error?: string }
export interface BindingResource { close(): Promise<void> }
export class ActivationCleanupError extends Error { constructor(readonly resource: BindingResource) { super('Binding cleanup incomplete') } }
/** A specific, localizable reason why one binding could not activate. */
export class BindingActivationError extends Error {
  constructor(readonly code: Exclude<BindingErrorCode, 'teardown-incomplete'>, message?: string, options?: ErrorOptions) {
    super(message ?? code, options)
  }
}
type Factory = (binding: Binding, signal: AbortSignal, state: (phase: string) => void) => Promise<BindingResource>
type Logger = (message: string, details?: unknown) => void
const fingerprint = (binding: Binding) => JSON.stringify(binding)

/** Transport activation only. Native DSH continues to own execution and sessions. */
export class ChannelManager {
  private desired: Binding[] = []
  private live = new Map<string, { fingerprint: string; abort: AbortController; resource?: BindingResource }>()
  private states = new Map<string, BindingStatus>()
  private listeners = new Set<() => void>()
  private queue = Promise.resolve()
  private closed = false
  private generation = 0
  private configError: string | undefined
  constructor(private readonly start: Factory, private readonly log: Logger = () => {}) {}
  /** Observe config and lifecycle transitions; used by the settings stream and project grouping. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { for (const listener of this.listeners) { try { listener() } catch { /* observers must not break lifecycle */ } } }
  private setState(status: BindingStatus): void { this.states.set(status.id, status); this.changed() }
  rejectConfiguration(): void {
    this.configError = 'config-invalid'
    this.log('saved channel configuration is invalid; keeping the current consumers')
    this.changed()
  }
  bindings(): Binding[] { return structuredClone(this.desired) }
  status(): { bindings: BindingStatus[]; configError?: string } {
    return { ...(this.configError ? { configError: this.configError } : {}), bindings: this.desired.map(b => ({ ...(this.states.get(b.id) ?? { id: b.id, phase: 'stopped' }) })) }
  }
  update(bindings: Binding[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Channel manager is closed'))
    this.configError = undefined
    this.desired = structuredClone(bindings)
    this.generation += 1
    for (const [id, item] of this.live) {
      const next = bindings.find(b => b.id === id && b.enabled)
      if (!next || fingerprint(next) !== item.fingerprint) item.abort.abort()
    }
    this.changed()
    this.queue = this.queue.catch(() => {}).then(() => this.reconcile())
    return this.queue
  }
  private async reconcile(): Promise<void> {
    if (this.closed) return
    for (const [id, item] of this.live) if (item.abort.signal.aborted) {
      this.setState({ id, phase: 'stopping' })
      try { await item.resource?.close() } catch (error) {
        this.log(`binding ${id} teardown failed; refusing to reconnect`, error)
        this.setState({ id, phase: 'error', error: 'teardown-incomplete' })
        // Never start a competing consumer after an uncertain teardown.
        throw new Error('Channel teardown incomplete')
      }
      this.live.delete(id)
    }
    const generation = this.generation
    for (const binding of this.desired) {
      if (this.closed || generation !== this.generation) return
      if (!binding.enabled) { this.setState({ id: binding.id, phase: 'stopped' }); continue }
      if (this.live.has(binding.id)) continue
      const item: { fingerprint: string; abort: AbortController; resource?: BindingResource } = { fingerprint: fingerprint(binding), abort: new AbortController() }
      this.live.set(binding.id, item)
      this.setState({ id: binding.id, phase: 'starting' })
      try {
        const resource = await this.start(binding, item.abort.signal, phase => {
          if (!this.closed && !item.abort.signal.aborted && this.live.get(binding.id) === item) this.setState({ id: binding.id, phase })
        })
        item.resource = resource
        if (item.abort.signal.aborted || this.closed) await resource.close()
      } catch (error) {
        if (item.resource || error instanceof ActivationCleanupError) {
          if (error instanceof ActivationCleanupError) item.resource = error.resource
          item.abort.abort()
          this.log(`binding ${binding.id} teardown failed after activation`, error)
          this.setState({ id: binding.id, phase: 'error', error: 'teardown-incomplete' })
          throw new Error('Channel teardown incomplete')
        }
        if (!item.abort.signal.aborted && !this.closed) {
          const code = error instanceof BindingActivationError ? error.code : 'activation-failed'
          this.log(`binding ${binding.id} failed to activate`, error)
          this.setState({ id: binding.id, phase: 'error', error: code })
        }
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
    this.changed()
    if (results.some(r => r.status === 'rejected')) throw new Error('Channel teardown incomplete')
  }
}

/** Read-only status exported through the host's native Remote gateway. */
export class ChannelsController extends TypertRemoteService {
  constructor(ctx: Context, private readonly manager: ChannelManager) { super(ctx, 'channelsController', { namespace: 'channels' }) }
  @Remote('status')
  status(): { bindings: BindingStatus[]; configError?: string } { return this.manager.status() }
  @Remote('bindings')
  bindings(): Binding[] { return this.manager.bindings() }
  /** Local extension point for same-process consumers; not part of the remote wire. */
  subscribe(listener: () => void): () => void { return this.manager.subscribe(listener) }
  /** Push lifecycle transitions instead of making the panel poll. */
  @Remote({ mode: 'stream' })
  async *statusStream(signal: AbortSignal): AsyncIterable<{ bindings: BindingStatus[]; configError?: string }> {
    let previous: string | undefined
    let dirty = true, disposed = false
    let wake: (() => void) | undefined
    // Capacity one: changes during a suspended yield retain the latest snapshot.
    const release = this.manager.subscribe(() => { dirty = true; wake?.() })
    const stop = () => { if (disposed) return; disposed = true; release(); wake?.() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      while (!signal.aborted) {
        dirty = false
        const value = this.manager.status()
        const key = JSON.stringify(value)
        if (key !== previous) { previous = key; yield value }
        if (signal.aborted) return
        if (!dirty) await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', stop)
      stop()
    }
  }
}

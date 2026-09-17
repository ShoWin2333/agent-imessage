import { Worker } from 'node:worker_threads'
import { BaseBackend, type SessionOptions } from './types.js'
import type { RouteConfig } from '../gateway/config.js'

/** SDK tools get an isolated environment: Photon credentials never enter the agent runtime. */
export class IsolatedCursorBackend extends BaseBackend {
  private readonly worker: Worker
  private sequence = 0
  private closed = false
  private closing: Promise<void> | undefined
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  constructor(route: RouteConfig, apiKey: string, secretNames: string[]) {
    super()
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (/^(PHOTON_|SPECTRUM_)/.test(name)) delete env[name]
    for (const name of [...secretNames, 'CURSOR_API_KEY']) delete env[name]
    this.worker = new Worker(new URL('./cursor-worker.js', import.meta.url), { env, workerData: { route, apiKey } })
    this.worker.on('message', message => {
      if (message.type === 'event') this.onEvent(message.event)
      if (message.type === 'request') void this.onRequest(message.request).then(result => this.worker.postMessage({ type: 'answer', id: message.id, result }), () => this.worker.postMessage({ type: 'answer', id: message.id, error: true }))
      if (message.type === 'result') {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id); clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new Error('Cursor SDK operation failed; check local credentials and sandbox support'))
        else waiter.resolve(message.result)
      }
    })
    this.worker.on('error', () => { void this.close() })
    this.worker.on('exit', () => { this.finish() })
  }
  private call(method: string, params = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Backend closed'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close() }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, method, ...params })
    })
  }
  async initialize(): Promise<void> { await this.call('initialize') }
  async openSession(options: SessionOptions): Promise<{ id: string; cwd: string }> { return await this.call('openSession', { options }) as { id: string; cwd: string } }
  async startTurn(sessionId: string, text: string): Promise<string> { return await this.call('startTurn', { sessionId, text }) as string }
  async cancel(sessionId: string, turnId: string): Promise<void> { await this.call('cancel', { sessionId, turnId }) }
  private finish(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Backend closed')) }
    this.pending.clear()
    this.onClose()
  }
  close(): Promise<void> { return this.closing ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    if (this.closed) return
    // Let the SDK cancel its subprocesses before terminating a stuck worker.
    const timer = setTimeout(() => { void this.worker.terminate() }, 10_000)
    try { await this.call('close') } catch { /* exit rejects outstanding calls */ }
    finally { clearTimeout(timer); this.finish(); await this.worker.terminate() }
  }
}

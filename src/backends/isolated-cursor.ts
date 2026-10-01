import { Worker, type WorkerOptions } from 'node:worker_threads'
import { BaseBackend, type SessionOptions } from './types.js'
import { BackendOperationError, backendDiagnostic, readBackendDiagnostic, type BackendStage } from './failure.js'
import type { RouteConfig } from '../gateway/config.js'

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker
/** SDK tools get an isolated environment: Photon credentials never enter the agent runtime. */
export class IsolatedCursorBackend extends BaseBackend {
  private worker: Worker
  private readonly workerOptions: WorkerOptions
  private sequence = 0
  private closed = false
  private closing: Promise<void> | undefined
  private opening = false
  private activeTurn = false
  private selection: string | undefined
  private readonly retiring = new Set<Worker>()
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; stage: BackendStage }>()
  constructor(route: RouteConfig, apiKey: string, secretNames: string[], private readonly workerFactory: WorkerFactory = (url, options) => new Worker(url, options)) {
    super()
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (/^(PHOTON_|SPECTRUM_)/.test(name)) delete env[name]
    for (const name of [...secretNames, 'CURSOR_API_KEY']) delete env[name]
    this.workerOptions = { env, workerData: { route, apiKey } }
    this.worker = this.spawn()
  }
  private spawn(): Worker {
    const worker = this.workerFactory(new URL('./cursor-worker.js', import.meta.url), this.workerOptions)
    worker.on('message', message => {
      if (worker !== this.worker || this.closed) return
      if (message.type === 'event' && !this.retiring.has(worker)) {
        if (message.event.type === 'started') this.activeTurn = true
        if (message.event.type === 'completed') this.activeTurn = false
        this.onEvent(message.event)
      }
      if (message.type === 'request' && !this.retiring.has(worker)) void this.onRequest(message.request).then(result => {
        if (worker === this.worker && !this.closed) worker.postMessage({ type: 'answer', id: message.id, result })
      }, () => {
        if (worker === this.worker && !this.closed) worker.postMessage({ type: 'answer', id: message.id, error: true })
      })
      if (message.type === 'result') {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id); clearTimeout(waiter.timer)
        if (message.error) waiter.reject(new BackendOperationError(readBackendDiagnostic(message.error, waiter.stage)))
        else waiter.resolve(message.result)
      }
    })
    worker.on('error', error => { if (worker === this.worker) this.finish(error) })
    worker.on('exit', () => { if (worker === this.worker && (!this.retiring.has(worker) || this.pending.size)) this.finish() })
    return worker
  }
  private call(method: string, params = {}, stage: BackendStage = 'initialize'): Promise<unknown> {
    if (this.closed) return Promise.reject(new BackendOperationError({stage,failure:'unknown',causes:[]}))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BackendOperationError({stage,failure:'timeout',causes:[]}))
        void this.close()
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer, stage })
      try { this.worker.postMessage({ id, method, ...params }) }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(new BackendOperationError(backendDiagnostic(error,stage))) }
    })
  }
  async initialize(): Promise<void> { await this.call('initialize') }
  async openSession(options: SessionOptions): Promise<{ id: string; cwd: string }> {
    if (this.opening || this.activeTurn || this.pending.size) throw new BackendOperationError({stage:options.id ? 'session-resume' : 'session-create',failure:'session-busy',causes:[]})
    this.opening = true
    try {
      // SDK 1.0.31 caches model lists in its local runtime without a TTL. Replace
      // that runtime only before admission, preserving the caller's session ID.
      const selection = JSON.stringify([options.model ?? '', options.effort ?? 'default', options.speed ?? 'default'])
      if (this.selection !== undefined && this.selection !== selection) await this.refreshWorker()
      this.selection = selection
      const session = await this.call('openSession', { options }, options.id ? 'session-resume' : 'session-create') as { id: string; cwd: string }
      return session
    } finally { this.opening = false }
  }
  private async refreshWorker(): Promise<void> {
    const old = this.worker
    this.retiring.add(old)
    try {
      await this.call('close', {}, 'worker-refresh')
      await old.terminate()
      if (this.closed) throw new BackendOperationError({stage:'worker-refresh',failure:'aborted',causes:[]})
      this.worker = this.spawn()
      await this.call('initialize', {}, 'worker-refresh')
    } catch (error) {
      // No admission or message is replayed if retirement/initialization fails.
      this.finish()
      await this.worker.terminate()
      throw error
    } finally { this.retiring.delete(old) }
  }
  async startTurn(sessionId: string, text: string): Promise<string> {
    if (this.opening || this.activeTurn) throw new BackendOperationError({stage:'turn-start',failure:'session-busy',causes:[]})
    // Protect admission even before the worker emits started.
    this.activeTurn = true
    try { return await this.call('startTurn', { sessionId, text }, 'turn-start') as string }
    catch (error) { this.activeTurn = false; throw error }
  }
  async cancel(sessionId: string, turnId: string): Promise<void> { await this.call('cancel', { sessionId, turnId }, 'cancel') }
  private finish(error?: unknown): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new BackendOperationError(backendDiagnostic(error,waiter.stage))) }
    this.pending.clear()
    this.onClose()
  }
  close(): Promise<void> { return this.closing ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    if (this.closed) return
    // Let the SDK cancel its subprocesses before terminating a stuck worker.
    const timer = setTimeout(() => { void this.worker.terminate() }, 10_000)
    try { await this.call('close', {}, 'close') } catch { /* exit rejects outstanding calls */ }
    finally { clearTimeout(timer); this.finish(); await this.worker.terminate() }
  }
}

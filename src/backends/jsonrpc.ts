import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type ObjectValue = Record<string, unknown>
export function object(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ObjectValue : {}
}
export interface Rpc {
  request(method: string, params: ObjectValue): Promise<ObjectValue>
  onNotification: (method: string, params: ObjectValue) => void
  onRequest: (method: string, params: ObjectValue) => Promise<unknown>
  onClose: () => void
  close(): void
}

/** One private stdio connection per route; raw server errors and stderr never reach iMessage. */
export class JsonRpcProcess implements Rpc {
  onNotification: Rpc['onNotification'] = () => {}
  onRequest: Rpc['onRequest'] = async () => { throw new Error('Unsupported server request') }
  onClose: Rpc['onClose'] = () => {}
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<void>
  private readonly pending = new Map<number, { resolve(value: ObjectValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private closed = false

  constructor(binary = 'codex', cwd = process.cwd(), privateEnvNames: string[] = [], private readonly wire: { args: string[]; jsonrpc?: boolean; env?: Record<string, string> } = { args: ['app-server', '--listen', 'stdio://'] }) {
    const env = { ...process.env, ...wire.env }
    for (const name of Object.keys(env)) if (/^(PHOTON_|SPECTRUM_)/.test(name)) delete env[name]
    for (const name of privateEnvNames) delete env[name]
    this.child = spawn(binary, wire.args, { cwd, env, stdio: 'pipe', shell: false })
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()))
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.close())
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try { this.receive(object(JSON.parse(line))) } catch { this.close() }
    })
  }

  request(method: string, params: ObjectValue, timeoutMs = 60_000): Promise<ObjectValue> {
    if (this.closed) return Promise.reject(new Error('Agent connection closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An uncertain turn/start must not leave a detached turn executing.
        this.close()
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Agent connection closed or request timed out'))
    }
    this.pending.clear()
    this.child.kill()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    timer.unref()
    this.onClose()
  }

  waitClosed(): Promise<void> { return this.exited }

  notify(method: string, params: ObjectValue): void { this.write({ method, params }) }

  protected write(value: ObjectValue): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(this.wire.jsonrpc ? { ...value, jsonrpc: '2.0' } : value)}\n`)
  }

  private receive(message: ObjectValue): void {
    if (typeof message.method === 'string') {
      const params = object(message.params)
      if (message.id !== undefined) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') return
        const id = message.id
        void this.onRequest(message.method, params).then(
          result => this.write({ id, result }),
          () => this.write({ id, error: { code: -32603, message: 'Request unavailable or rejected by bridge' } }),
        )
      } else this.onNotification(message.method, params)
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error !== undefined) pending.reject(new Error('Agent rejected the request; check local configuration and account access'))
    else pending.resolve(object(message.result))
  }
}

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
export class AppServer implements Rpc {
  onNotification: Rpc['onNotification'] = () => {}
  onRequest: Rpc['onRequest'] = async () => { throw new Error('Unsupported server request') }
  onClose: Rpc['onClose'] = () => {}
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, { resolve(value: ObjectValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 0
  private closed = false

  constructor(binary = 'codex', cwd = process.cwd(), privateEnvNames: string[] = []) {
    const env = { ...process.env }
    for (const name of privateEnvNames) delete env[name]
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: 'pipe', shell: false })
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.close())
    this.child.on('error', () => this.close())
    this.child.on('exit', () => this.close())
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      try { this.receive(object(JSON.parse(line))) } catch { this.close() }
    })
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'agent_imessage', title: 'Agent iMessage', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.write({ method: 'initialized' })
  }

  request(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (this.closed) return Promise.reject(new Error('Codex connection closed'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // An uncertain turn/start must not leave a detached turn executing.
        this.close()
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error('Codex connection closed or request timed out'))
    }
    this.pending.clear()
    this.child.kill()
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    timer.unref()
    this.onClose()
  }

  private write(value: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(value)}\n`)
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
    if (message.error !== undefined) pending.reject(new Error('Codex rejected the request; check local configuration and account access'))
    else pending.resolve(object(message.result))
  }
}

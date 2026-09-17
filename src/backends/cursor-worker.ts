import { parentPort, workerData } from 'node:worker_threads'
import { CursorBackend } from './cursor.js'
import type { RouteConfig } from '../gateway/config.js'
import type { SessionOptions } from './types.js'
const port = parentPort!
const backend = new CursorBackend(workerData.route as RouteConfig, String(workerData.apiKey))
let sequence = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
backend.onEvent = event => port.postMessage({ type: 'event', event })
backend.onClose = () => port.postMessage({ type: 'closed' })
backend.onRequest = request => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); port.postMessage({ type: 'request', id, request }) })
port.on('message', message => {
  if (message.type === 'answer') {
    const waiter = pending.get(message.id); pending.delete(message.id)
    if (message.error) waiter?.reject(new Error('Request rejected')); else waiter?.resolve(message.result)
    return
  }
  void (async () => {
    switch (message.method) {
      case 'initialize': return backend.initialize()
      case 'openSession': return backend.openSession(message.options as SessionOptions)
      case 'startTurn': return backend.startTurn(message.sessionId, message.text)
      case 'cancel': return backend.cancel(message.sessionId, message.turnId)
      case 'close': {
        for (const item of pending.values()) item.reject(new Error('Closed'))
        pending.clear()
        return backend.close()
      }
      default: throw new Error('Unknown method')
    }
  })().then(result => port.postMessage({ type: 'result', id: message.id, result }), () => port.postMessage({ type: 'result', id: message.id, error: true }))
})

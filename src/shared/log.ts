/** Internal diagnostic sink for transport failures. Never receives message text or credentials. */
export type ChannelLog = (event: string, detail?: unknown) => void

/** Default sink for tests and for call sites that do not pass one. */
export const silentLog: ChannelLog = () => {}

const SECRET = /(bearer\s+[^\s,;]+|bot\d+:[A-Za-z0-9_-]{8,}|(?:token|appsecret|app_secret|secret)\s*[=:]\s*\S+)/gi

/**
 * Reduce an arbitrary failure to one bounded, credential-free line. Provider
 * errors can embed request URLs or tokens, so only the error identity and a
 * scrubbed message survive.
 */
export function sanitizeDetail(detail: unknown): string {
  const code = detail instanceof Error ? (detail as unknown as { code?: unknown }).code : undefined
  const name = detail instanceof Error
    ? (detail.name && detail.name !== 'Error' ? detail.name : detail.constructor?.name ?? 'Error')
    : ''
  const raw = detail instanceof Error
    ? `${name}${typeof code === 'string' ? `[${code}]` : ''}: ${detail.message}`
    : typeof detail === 'string' ? detail : (() => { try { return JSON.stringify(detail) } catch { return String(detail) } })()
  return raw.replace(SECRET, '[redacted]').slice(0, 300)
}

/** Reject when `work` does not settle inside `ms`, without cancelling it. */
export function withDeadline<T>(work: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
    timer.unref?.()
    work.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

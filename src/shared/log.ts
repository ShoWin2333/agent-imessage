/** Internal diagnostic sink. Provider details are untrusted and must never be serialized directly. */
export type ChannelLog = (event: string, detail?: unknown) => void

/** Default sink for tests and for call sites that do not pass one. */
export const silentLog: ChannelLog = () => {}

/** Keep diagnostic identity, never arbitrary provider messages or objects. */
export function sanitizeDetail(detail: unknown): string {
  if (!(detail instanceof Error)) return `Non-Error failure (${typeof detail})`
  const identity = detail.constructor?.name ?? 'Error'
  const name = /^(?:Error|[A-Za-z][A-Za-z0-9]{0,63}(?:Error|Exception))$/.test(identity) ? identity : 'Error'
  const code = (detail as Error & { code?: unknown }).code
  const safeCode = typeof code === 'number' && Number.isSafeInteger(code) ? String(code)
    : typeof code === 'string' && /^E[A-Z0-9_]{1,63}$/.test(code) ? code : undefined
  return `${name}${safeCode===undefined?'':`[${safeCode}]`}`
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

/** A timeout/abort means delivery is ambiguous; it never causes an automatic retry. */
export async function bounded<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('Delivery outcome unknown'))
      timer = setTimeout(onAbort, timeoutMs)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, {once:true})
    })])
  } finally {clearTimeout(timer);signal?.removeEventListener('abort', onAbort)}
}

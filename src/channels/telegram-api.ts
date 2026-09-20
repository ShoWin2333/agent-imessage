import type { OutboundMediaPayload } from '../media.js'
import { record } from './weixin-api.js'

export class TelegramError extends Error {
  constructor(readonly code: number, readonly retryAfter = 0) { super('Telegram request failed') }
}
/** Fixed origin, bounded responses and sanitized errors: token URLs never escape. */
export class TelegramApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(token: string, method: string, body: Record<string, unknown> | FormData, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method:'POST', redirect:'error', signal:AbortSignal.any([signal,AbortSignal.timeout(40_000)]),
        ...(body instanceof FormData ? {body} : {headers:{'content-type':'application/json'},body:JSON.stringify(body)}),
      })
      const reader = response.body?.getReader()
      if (!reader) throw new TelegramError(response.status)
      const chunks: Uint8Array[] = []; let size = 0
      let result: Record<string, unknown>
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break
          size += next.value.length
          if (size > 4 * 1024 * 1024) throw new TelegramError(0)
          chunks.push(next.value)
        }
        result = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } finally { await reader.cancel().catch(()=>{}) }
      if (!response.ok || result.ok !== true) {
        const retry = record(result.parameters).retry_after
        throw new TelegramError(typeof result.error_code === 'number' ? result.error_code : response.status,
          typeof retry === 'number' && Number.isFinite(retry) ? Math.max(0,Math.min(retry,3600)) * 1000 : 0)
      }
      return result.result
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof TelegramError) throw error
      throw new TelegramError(0)
    }
  }
  async file(token: string, chat: string, media: OutboundMediaPayload, signal: AbortSignal) {
    const body = new FormData()
    body.set('chat_id',chat)
    body.set('document',new Blob([new Uint8Array(media.bytes)],{type:media.mimeType}),media.name)
    await this.request(token,'sendDocument',body,signal)
  }
}

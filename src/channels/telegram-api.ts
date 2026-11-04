import type { OutboundMediaPayload } from '../media.js'
import { record } from './weixin-api.js'
import { oggOpusDuration } from './ogg-opus.js'

/** sendVoice accepts Ogg Opus, MP3 and M4A, not arbitrary audio (e.g. WAV). */
export function supportsTelegramVoice(media: OutboundMediaPayload): boolean {
  const {bytes, mimeType} = media, name = media.name.toLowerCase()
  if (name.endsWith('.ogg') && mimeType === 'audio/ogg') return oggOpusDuration(bytes) !== undefined
  if (name.endsWith('.mp3') && mimeType === 'audio/mpeg') {
    let offset = 0
    if (bytes.length >= 10 && bytes.toString('ascii',0,3) === 'ID3') {
      if ([6,7,8,9].some(index => bytes[index]! > 127)) return false
      offset = 10 + (bytes[6]! << 21 | bytes[7]! << 14 | bytes[8]! << 7 | bytes[9]!)
      if (bytes[5]! & 16) offset += 10
    }
    return offset+4 <= bytes.length && bytes[offset] === 255 && (bytes[offset+1]! & 0xe0) === 0xe0 &&
      (bytes[offset+1]! & 0x18) !== 8 && (bytes[offset+1]! & 6) === 2 &&
      (bytes[offset+2]! & 0xf0) !== 0 && (bytes[offset+2]! & 0xf0) !== 0xf0 && (bytes[offset+2]! & 12) !== 12
  }
  if (name.endsWith('.m4a') && mimeType === 'audio/mp4' && bytes.length >= 16 && bytes.toString('ascii',4,8) === 'ftyp') {
    const size = bytes.readUInt32BE(0)
    if (size < 16 || size > bytes.length || size % 4 !== 0) return false
    // An M4A brand identifies audio-only MPEG-4; generic/video MP4 is not assumed compatible.
    for (let offset = 8; offset < size; offset += 4) if (offset !== 12 && bytes.toString('ascii',offset,offset+4) === 'M4A ') return true
  }
  return false
}

export class TelegramError extends Error {
  constructor(readonly code: number, readonly retryAfter = 0) { super('Telegram request failed') }
}
/** Fixed origin, bounded responses and sanitized errors: token URLs never escape. */
export class TelegramApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(token: string, method: string, body: Record<string, unknown> | FormData, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
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
  async photo(token: string, chat: string, media: OutboundMediaPayload, signal: AbortSignal) {
    const body = new FormData()
    body.set('chat_id',chat)
    body.set('photo',new Blob([new Uint8Array(media.bytes)],{type:media.mimeType}),media.name)
    await this.request(token,'sendPhoto',body,signal)
  }
  async voice(token: string, chat: string, media: OutboundMediaPayload, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!supportsTelegramVoice(media)) throw new Error('Telegram native voice requires Ogg Opus, MP3 or M4A; use file delivery for incompatible audio')
    const body = new FormData()
    body.set('chat_id',chat)
    body.set('voice',new Blob([new Uint8Array(media.bytes)],{type:media.mimeType}),media.name)
    await this.request(token,'sendVoice',body,signal)
  }
  async file(token: string, chat: string, media: OutboundMediaPayload, signal: AbortSignal) {
    const body = new FormData()
    body.set('chat_id',chat)
    body.set('document',new Blob([new Uint8Array(media.bytes)],{type:media.mimeType}),media.name)
    await this.request(token,'sendDocument',body,signal)
  }
}

import { sniffAudio } from './audio.js'
import type { AudioClip } from './types.js'

/** Provider failures are surfaced without request headers, payloads, or keys. */
export class SpeechApiError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`语音接口返回 ${status}${detail ? `：${detail}` : ''}`)
    this.name = 'SpeechApiError'
  }
}

export interface SpeechApiOptions {
  apiKey: string
  /** Full API prefix such as `https://api.openai.com/v1`, without a trailing slash. */
  baseURL: string
  /** Injectable for tests; defaults to the runtime fetch. */
  fetch?: typeof fetch | undefined
}

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_ERROR_BODY = 300

/** Native audio understanding first; speech synthesis only after Agent work. */
export class SpeechApi {
  private readonly base: string
  private readonly key: string
  private readonly fetchImpl: typeof fetch
  constructor(options: SpeechApiOptions) {
    this.base = options.baseURL.replace(/\/+$/, '')
    this.key = options.apiKey
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** `clip` must already be wav or mp3; callers normalise other containers. */
  async turn(clip: AudioClip, options: { model: string; instructions?: string; context?: string | undefined }, signal: AbortSignal): Promise<{ text: string }> {
    signal.throwIfAborted()
    const format = sniffAudio(clip.bytes)
    if (format !== 'wav' && format !== 'mp3') throw new Error('Expected actual WAV or MP3 audio bytes')
    const content: unknown[] = [{ type: 'input_audio', input_audio: { data: clip.bytes.toString('base64'), format } }]
    const messages: unknown[] = [{ role: 'system', content: 'Understand the real recording and provide the original Agent with the user intent and relevant audible details needed for their request. This is an internal listening result, not a user reply. You cannot execute tools; never claim that notes, files or other actions have been completed. Preserve relevant acoustic observations rather than only producing a transcript.' }]
    const instructions = options.instructions?.trim()
    if (instructions) messages.push({ role: 'system', content: instructions })
    if (options.context?.trim()) content.unshift({ type: 'text', text: options.context.trim() })
    messages.push({ role: 'user', content })
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        modalities: ['text'],
        store: false,
        messages,
      }),
    }, signal)
    const data = await readJson(response)
    signal.throwIfAborted()
    const choices = Array.isArray(data.choices) ? data.choices : []
    const first: unknown = choices[0]
    const message = first && typeof first === 'object' ? (first as { message?: Record<string, unknown> }).message : undefined
    const text = typeof message?.content === 'string' ? message.content.trim() : ''
    if (!text) throw new SpeechApiError(502, '响应里没有原声听取结果，未生成最终语音')
    return { text }
  }

  /** Synthesize the exact final Agent script, never the unexecuted user request. */
  async speak(text: string, options: { model: string; voice: string }, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted()
    if (!text.trim() || text.length > 4096) throw new Error('最终答复为空或超过语音合成 4096 字符限制；未截断内容')
    const response = await this.request('/audio/speech', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: options.model, voice: options.voice, input: text, response_format: 'mp3' }),
    }, signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('语音合成没有返回音频')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 20 * 1024 * 1024) throw new Error('生成语音超过 20 MiB')
        chunks.push(next.value)
      }
    } finally { await reader.cancel() }
    signal.throwIfAborted()
    const audio = Buffer.concat(chunks)
    if (sniffAudio(audio) !== 'mp3') throw new Error('语音合成未返回有效 MP3 音频')
    return audio
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    if (!this.key) throw new SpeechApiError(401, '未配置 API Key')
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.key}`)
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)]),
    })
    if (!response.ok) throw new SpeechApiError(response.status, await safeDetail(response))
    return response
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => undefined)
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

async function safeDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    const parsed: unknown = JSON.parse(text)
    const message = parsed && typeof parsed === 'object' && 'error' in parsed
      ? (parsed as { error?: { message?: unknown } }).error?.message : undefined
    return (typeof message === 'string' ? message : text).slice(0, MAX_ERROR_BODY)
  } catch { return '' }
}

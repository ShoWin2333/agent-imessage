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

/**
 * One audio-in / audio-out turn. The recording is handed to the model
 * unchanged (only the container is normalised when the channel produced
 * something the API cannot read), so the model hears the learner itself and
 * decides what to say — nothing here interprets or scores the speech.
 */
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
  async turn(clip: AudioClip, options: { model: string; voice: string; instructions?: string; context?: string | undefined }, signal: AbortSignal): Promise<{ audio: Buffer; text: string }> {
    signal.throwIfAborted()
    const format = sniffAudio(clip.bytes)
    if (format !== 'wav' && format !== 'mp3') throw new Error('Expected actual WAV or MP3 audio bytes')
    const content: unknown[] = [{ type: 'input_audio', input_audio: { data: clip.bytes.toString('base64'), format } }]
    const messages: unknown[] = []
    const instructions = options.instructions?.trim()
    if (instructions) messages.push({ role: 'system', content: instructions })
    if (options.context?.trim()) content.unshift({ type: 'text', text: options.context.trim() })
    messages.push({ role: 'user', content })
    const response = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        modalities: ['text', 'audio'],
        audio: { voice: options.voice, format: 'mp3' },
        messages,
      }),
    }, signal)
    const data = await readJson(response)
    signal.throwIfAborted()
    const choices = Array.isArray(data.choices) ? data.choices : []
    const first: unknown = choices[0]
    const message = first && typeof first === 'object' ? (first as { message?: Record<string, unknown> }).message : undefined
    const audio = message && typeof message.audio === 'object' && message.audio !== null ? message.audio as { data?: unknown; transcript?: unknown } : undefined
    const encoded = typeof audio?.data === 'string' ? audio.data : ''
    if (encoded.length > 28 * 1024 * 1024) throw new SpeechApiError(502, '返回音频超过大小限制')
    if (!encoded) throw new SpeechApiError(502, '响应里没有音频数据，请确认模型支持音频输出')
    // Only the transcript attached to this generated audio is reliable for
    // conversation continuity and duplicate suppression; content may differ.
    const text = typeof audio?.transcript === 'string' ? audio.transcript.trim() : ''
    if (!text) throw new SpeechApiError(502, '响应里没有同一语音回复的文字稿，无法保留到原会话')
    return { audio: Buffer.from(encoded, 'base64'), text }
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

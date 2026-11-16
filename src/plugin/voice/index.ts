import { randomUUID } from 'node:crypto'
import { AUDIO_CHAT_SAFE, decodeToWav, formatFromName, sniffAudio, type AudioConversionServices } from './audio.js'
import { decodeSilkToWav } from './silk.js'
import { SpeechApi } from './speech.js'
import type { AudioClip, VoiceReply, VoiceSettings } from './types.js'

export { SpeechApi, SpeechApiError } from './speech.js'
export type { AudioClip, VoiceReply, VoiceSettings } from './types.js'
export type { AudioConversionServices } from './audio.js'

export interface VoiceTurnInput {
  context?: string | undefined
  clip: AudioClip
  /** Composer capabilities of the channel Agent, used only to normalise a container. */
  audio?: AudioConversionServices | undefined
  signal: AbortSignal
}

/**
 * The whole voice feature: hand the recording to the model and send back what
 * it says. No transcription, no scoring — the model does the listening.
 */
export interface VoiceCoach {
  readonly enabled: boolean
  /** Why the coach is disabled; safe to log and show, never contains the key. */
  readonly note?: string
  readonly engine?: string
  turn(input: VoiceTurnInput): Promise<VoiceReply>
}

export function createVoiceCoach(settings: VoiceSettings, apiKey: string | undefined): VoiceCoach {
  const note = !settings.enabled ? '语音功能未启用'
    : !settings.credentialRef ? '未配置语音凭据引用'
      : !apiKey ? '语音凭据未设置'
        : undefined
  const api = note === undefined && apiKey !== undefined ? new SpeechApi({ apiKey, baseURL: settings.baseURL }) : undefined
  return {
    enabled: settings.enabled,
    ...(note === undefined ? {} : { note }),
    ...(api === undefined ? {} : { engine: `OpenAI · ${settings.model}` }),
    async turn(input) {
      if (!api) throw new Error(note ?? '语音能力不可用')
      input.signal.throwIfAborted()
      if (input.clip.bytes.length > 10 * 1024 * 1024) throw new Error('录音超过 10 MiB，未发送到音频模型。')
      const clip = await normalise(input)
      input.signal.throwIfAborted()
      if (clip.bytes.length > 20 * 1024 * 1024) throw new Error('转换后录音超过 20 MiB。')
      const reply = await api.turn(clip, { model: settings.model, voice: settings.voice, instructions: settings.instructions, context: input.context }, input.signal)
      return {
        audio: reply.audio,
        name: `voice-${randomUUID().slice(0, 8)}.mp3`,
        mimeType: 'audio/mpeg',
        text: reply.text,
      }
    },
  }
}

/**
 * The API reads wav and mp3 only. QQ delivers Tencent SILK, which ffmpeg cannot
 * decode, so SILK goes through the optional decoder first; anything else is
 * piped through ffmpeg inside the Agent's sandbox.
 */
async function normalise(input: VoiceTurnInput): Promise<AudioClip> {
  const sniffed = sniffAudio(input.clip.bytes)
  const format = sniffed === 'unknown' ? formatFromName(input.clip.name) : sniffed
  if (sniffed !== 'unknown' && AUDIO_CHAT_SAFE.has(format)) return { ...input.clip, name: `voice.${format}`, mimeType: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }
  if (format === 'silk' || sniffed === 'silk') {
    const silk = await decodeSilkToWav(input.clip.bytes, input.signal)
    if (silk.ok) return { name: 'voice.wav', mimeType: 'audio/wav', bytes: silk.wav }
    throw new Error(silk.reason)
  }
  if (!input.audio) throw new Error('语音解码不可用：渠道会话尚未就绪')
  const decoded = await decodeToWav(input.clip.bytes, input.audio, input.signal)
  if (!decoded.ok) throw new Error(decoded.reason)
  return { name: 'voice.wav', mimeType: 'audio/wav', bytes: decoded.wav }
}

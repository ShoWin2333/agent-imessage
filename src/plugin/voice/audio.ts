import type { Readable } from 'node:stream'
import type { VoiceExecutionPolicy, VoiceSubprocess } from '../audio-preparation.js'

/** Containers the transcription and speech APIs accept unchanged. */
export const WHISPER_SAFE: ReadonlySet<AudioFormat> = new Set<AudioFormat>(['wav', 'mp3', 'm4a', 'ogg', 'flac', 'webm'])
/** The audio-input chat API is stricter than transcription. */
export const AUDIO_CHAT_SAFE: ReadonlySet<AudioFormat> = new Set<AudioFormat>(['wav', 'mp3'])

export type AudioFormat = 'wav' | 'mp3' | 'm4a' | 'ogg' | 'flac' | 'webm' | 'amr' | 'silk' | 'unknown'

/**
 * Container detection from leading bytes. QQ delivers Tencent voice as SILK,
 * which ffmpeg cannot decode; callers must report that instead of guessing.
 */
export function sniffAudio(bytes: Buffer): AudioFormat {
  if (bytes.length < 4) return 'unknown'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav'
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg'
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return 'flac'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm'
  // Tencent SILK v3 is a 0x02 marker followed by the "#!SILK_V3" magic; bare
  // "#!SILK" files exist too, so accept the magic at either offset.
  if (bytes.subarray(0, 7).toString('latin1').startsWith('#!SI') || bytes.subarray(1, 7).toString('latin1').startsWith('#!SI')) return 'silk'
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'm4a'
  if (bytes.length >= 12 && bytes.subarray(0, 5).toString('ascii') === '#!AMR') return 'amr'
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    // MPEG audio frame sync; AAC ADTS shares the prefix but is rare on this path.
    return bytes[1]! & 0x06 ? 'mp3' : 'unknown'
  }
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3'
  return 'unknown'
}

export interface AudioConversionServices {
  readonly subprocess?: VoiceSubprocess | undefined
  readonly sandbox?: { confine(argv: readonly string[], policy: VoiceExecutionPolicy & { mode: 'read-only' | 'workspace-write' }, signal?: AbortSignal): Promise<{ argv: string[] }> } | undefined
  readonly policy?: VoiceExecutionPolicy | undefined
  readonly cwd: string
  readonly executable?: string | undefined
}

const PCM_RATE = 16_000
const MAX_PCM_BYTES = PCM_RATE * 2 * 600
const INPUT_OPTIONS = [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
  '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0',
  '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
] as const

/**
 * Decode arbitrary audio to 16 kHz mono 16-bit WAV over pipes: no path from
 * untrusted media enters argv, no temporary files, and only the initiating
 * Agent's composed subprocess/sandbox capabilities are used.
 */
export async function decodeToWav(
  bytes: Buffer,
  services: AudioConversionServices,
  signal: AbortSignal,
): Promise<{ ok: true; wav: Buffer } | { ok: false; reason: string }> {
  const { subprocess, policy } = services
  if (!subprocess) return { ok: false, reason: '语音解码不可用：缺少 composer 子进程能力' }
  if (!policy) return { ok: false, reason: '语音解码不可用：缺少 composer 沙箱策略' }
  if (policy.mode !== 'danger-full-access' && !services.sandbox) return { ok: false, reason: '语音解码不可用：缺少 composer 沙箱能力' }
  let executable: string
  try {
    executable = await subprocess.resolveExecutable(services.executable ?? 'ffmpeg', undefined, signal)
  } catch {
    return { ok: false, reason: '语音解码不可用：未找到 ffmpeg' }
  }
  let argv: readonly string[] = [
    executable, ...INPUT_OPTIONS,
    '-ac', '1', '-ar', String(PCM_RATE), '-c:a', 'pcm_s16le', '-threads', '1', '-f', 's16le', 'pipe:1',
  ]
  if (policy.mode !== 'danger-full-access') {
    argv = (await services.sandbox!.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
  }
  signal.throwIfAborted()
  const pcm = await runPiped(subprocess, argv, services.cwd, bytes, MAX_PCM_BYTES, signal)
  if (!pcm.length || pcm.length % 2 !== 0) return { ok: false, reason: '语音解码失败：没有得到有效的 PCM 数据' }
  return { ok: true, wav: wrapWav(pcm) }
}

/** Minimal RIFF header; streaming decoders leave the sizes unknown. */
export function wrapWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(PCM_RATE, 24)
  header.writeUInt32LE(PCM_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

async function runPiped(
  subprocess: VoiceSubprocess, argv: readonly string[], cwd: string, input: Buffer, maxBytes: number, signal: AbortSignal,
): Promise<Buffer> {
  const handle = subprocess.spawn({ argv, cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 250, signal })
  let failure: unknown
  let stopping = false
  const stop = (error: unknown) => {
    failure ??= error
    if (stopping) return
    stopping = true
    handle.terminate()
    handle.stdin?.destroy()
  }
  const onAbort = () => stop(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const chunks: Buffer[] = []
  let total = 0
  const drain = async (stream: Readable | undefined, retain: boolean) => {
    if (!stream) { stop(new Error('子进程未提供音频管道')); return }
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array)
        if (!retain || stopping) continue
        if (chunk.length > maxBytes - total) stop(new Error('语音超过十分钟上限'))
        else { total += chunk.length; chunks.push(chunk) }
      }
    } catch (error) { stop(error) }
  }
  const stdout = drain(handle.stdout, true)
  const stderr = drain(handle.stderr, false)
  const write = async () => {
    if (!handle.stdin) { stop(new Error('子进程未提供音频输入管道')); return }
    try {
      await new Promise<void>((resolve, reject) => {
        handle.stdin!.on('error', reject)
        handle.stdin!.end(input, () => resolve())
      })
    } catch (error) { stop(error) }
  }
  const done = handle.done.then(outcome => {
    if (outcome.exitCode !== 0 || outcome.signal) stop(new Error(`ffmpeg 解码失败（exit ${outcome.exitCode ?? outcome.signal}）`))
  }, stop)
  try {
    await Promise.all([stdout, stderr, write(), done])
    const exited = await handle.waitForExit()
    if (!exited) throw new Error('无法确认音频子进程已退出')
    if (failure) throw failure
    signal.throwIfAborted()
    return Buffer.concat(chunks, total)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Narrow an outbound file name to a container hint when sniffing is inconclusive. */
export function formatFromName(name: string): AudioFormat {
  const extension = name.toLowerCase().replace(/^.*\./, '')
  switch (extension) {
    case 'wav': return 'wav'
    case 'mp3': return 'mp3'
    case 'm4a': case 'mp4': return 'm4a'
    case 'ogg': case 'oga': case 'opus': return 'ogg'
    case 'flac': return 'flac'
    case 'webm': return 'webm'
    case 'amr': return 'amr'
    case 'silk': return 'silk'
    default: return 'unknown'
  }
}

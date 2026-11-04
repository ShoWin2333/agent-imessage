import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, type OutboundMediaPayload } from '../media.js'

/** Structural subsets of the inspected agent-composed subprocess/sandbox contracts. */
export interface VoiceSubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
export interface VoiceSubprocess {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]; cwd: string
    stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe' }
    graceMs: number; signal?: AbortSignal
  }): VoiceSubprocessHandle
}
export interface VoiceExecutionPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}
export interface VoicePreparationServices {
  /** Resolve these from the initiating agent's context, never the plugin host. */
  subprocess?: VoiceSubprocess
  sandbox?: {
    confine(argv: readonly string[], policy: VoiceExecutionPolicy & { mode: 'read-only' | 'workspace-write' }, signal?: AbortSignal): Promise<{ argv: string[] }>
  }
  /** Resolve per execution with agent.ctx.sandboxPolicy.resolve({ session }). */
  policy?: VoiceExecutionPolicy
  /** Directory in the composed provider's execution world. */
  cwd: string
  /** Trusted deployment setting only; defaults to portable PATH lookup of ffmpeg. */
  executable?: string
  /** Total deadline for lookup, confinement, conversion and PCM decoding. */
  timeoutMs?: number
}
export type VoicePreparationResult =
  | { status: 'prepared'; media: OutboundMediaPayload }
  | { status: 'unavailable'; media: OutboundMediaPayload; note: string }

const PCM_RATE = 8000
const MAX_PCM_BYTES = PCM_RATE * 2 * 600
const MAX_DEADLINE_MS = 120_000
const INPUT_OPTIONS = [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
  '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0',
  '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
] as const

/**
 * Prepare already-approved, bounded audio bytes for native voice delivery. No
 * paths from media enter argv; both passes use pipes, a fixed protocol whitelist,
 * no temporary files, and only the initiating agent's composed capabilities.
 * Missing optional capabilities return an explicit file-fallback note. Denials,
 * invalid audio, resource limits and cancellation throw (never retry unconfined).
 */
export async function prepareVoiceMedia(
  media: OutboundMediaPayload,
  services: VoicePreparationServices,
  signal?: AbortSignal,
): Promise<VoicePreparationResult> {
  if (signal?.aborted) throw new Error('Voice preparation was cancelled.')
  if (media.bytes.length > DEFAULT_MAX_OUTBOUND_MEDIA_BYTES) throw new Error('Voice input exceeds the 20 MiB limit.')
  if (!media.bytes.length || !media.mimeType.startsWith('audio/')) throw new Error('Voice preparation requires non-empty audio bytes.')
  const unavailable = (note: string): VoicePreparationResult => ({ status: 'unavailable', media, note })
  const subprocess = services.subprocess
  const policy = services.policy
  if (!subprocess) return unavailable('Native voice preparation unavailable: composed subprocess capability is missing; send as an audio file.')
  if (!policy) return unavailable('Native voice preparation unavailable: composed sandbox policy is missing; send as an audio file.')
  if (policy.mode !== 'danger-full-access' && !services.sandbox) {
    return unavailable('Native voice preparation unavailable: composed sandbox capability is missing; send as an audio file.')
  }
  const timeoutMs = services.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DEADLINE_MS) throw new Error('Invalid voice preparation timeout.')
  const cancellation = new AbortController()
  const onAbort = () => cancellation.abort(new Error('Voice preparation was cancelled.'))
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => cancellation.abort(new Error('Voice preparation timed out.')), timeoutMs)
  try {
    let executable: string
    try {
      executable = await subprocess.resolveExecutable(services.executable ?? 'ffmpeg', undefined, cancellation.signal)
    } catch (error) {
      cancellation.signal.throwIfAborted()
      // The inspected provider exports this stable named error (without an
      // errno code); remote/older providers can retain the ordinary ENOENT shape.
      if ((error instanceof Error && error.name === 'SubprocessExecutableNotFoundError')
        || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) {
        return unavailable('Native voice preparation unavailable: ffmpeg executable was not found; send as an audio file.')
      }
      throw error
    }
    const run = async (input: Buffer, options: readonly string[], maxBytes: number, limitMessage: string) => {
      cancellation.signal.throwIfAborted()
      let argv: readonly string[] = [executable, ...INPUT_OPTIONS, ...options, 'pipe:1']
      if (policy.mode !== 'danger-full-access') {
        const confined = await services.sandbox!.confine(argv, { ...policy, mode: policy.mode }, cancellation.signal)
        argv = confined.argv
      }
      cancellation.signal.throwIfAborted()
      return runPiped(subprocess, argv, services.cwd, input, maxBytes, limitMessage, cancellation)
    }
    const ogg = await run(media.bytes, [
      '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k',
      '-vbr', 'on', '-application', 'voip', '-threads', '1', '-f', 'ogg',
    ], DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, 'Prepared voice exceeds the 20 MiB limit.')
    if (ogg.subarray(0, 4).toString('ascii') !== 'OggS' || !ogg.subarray(0, 128).includes(Buffer.from('OpusHead'))) {
      throw new Error('ffmpeg did not produce Ogg Opus audio.')
    }
    // Decode the actual result, not the input's guessed MIME or container tags.
    // Count PCM samples to respect Opus pre-skip/end trimming. Reject, never trim,
    // clips exceeding ten minutes (also bounds decoded-memory amplification).
    const pcm = await run(ogg, [
      '-ac', '1', '-ar', String(PCM_RATE), '-c:a', 'pcm_s16le', '-threads', '1', '-f', 's16le',
    ], MAX_PCM_BYTES, 'Voice audio exceeds the ten-minute duration limit.')
    if (!pcm.length || pcm.length % 2 !== 0) throw new Error('Voice audio decoded to invalid or empty PCM.')
    const voice = { durationSeconds: pcm.length / 2 / PCM_RATE, waveform: pcmWaveform(pcm) }
    const basename = media.name.replaceAll('\\', '/').split('/').pop()!.replace(/[\x00-\x1f\x7f]/g, '_')
    const stem = basename.replace(/\.[^.]*$/, '') || 'voice'
    return { status: 'prepared', media: { bytes: ogg, name: `${stem}.ogg`, mimeType: 'audio/ogg', voice } }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function runPiped(
  subprocess: VoiceSubprocess, argv: readonly string[], cwd: string, input: Buffer,
  maxBytes: number, limitMessage: string, cancellation: AbortController,
): Promise<Buffer> {
  const handle = subprocess.spawn({
    argv, cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 250, signal: cancellation.signal,
  })
  let failure: unknown
  let stopping = false
  const stop = (error: unknown) => {
    failure ??= error
    if (stopping) return
    stopping = true
    handle.terminate()
    // Also stop pending pipe writes. The service owns escalation and process tree.
    handle.stdin?.destroy()
  }
  const onAbort = () => stop(cancellation.signal.reason)
  cancellation.signal.addEventListener('abort', onAbort, { once: true })
  if (cancellation.signal.aborted) onAbort()
  const chunks: Buffer[] = []
  let total = 0
  const drain = async (stream: Readable | undefined, retain: boolean) => {
    if (!stream) { stop(new Error('Composed subprocess did not provide required audio pipes.')); return }
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        if (retain && !stopping) {
          if (chunk.length > maxBytes - total) stop(new Error(limitMessage))
          else { total += chunk.length; chunks.push(chunk) }
        }
        // Continue draining on overflow, termination, or cancellation; stderr is
        // deliberately never retained (arbitrarily verbose diagnostics are safe).
      }
    } catch (error) { stop(error) }
  }
  const stdout = drain(handle.stdout, true)
  const stderr = drain(handle.stderr, false)
  const write = async () => {
    if (!handle.stdin) { stop(new Error('Composed subprocess did not provide an audio input pipe.')); return }
    try {
      await pipeline(Readable.from((function* () {
        for (let offset = 0; offset < input.length; offset += 64 * 1024) yield input.subarray(offset, offset + 64 * 1024)
      })()), handle.stdin)
    } catch (error) { stop(error) }
  }
  // Observe done immediately: provider rejection must never become unhandled
  // while input/output are still streaming.
  const done = handle.done.then(outcome => {
    if (outcome.exitCode !== 0 || outcome.signal) stop(new Error(`ffmpeg audio preparation failed (exit ${outcome.exitCode ?? outcome.signal}).`))
  }, stop)
  try {
    await Promise.all([stdout, stderr, write(), done])
    // done is not necessarily managed-range quiescence. Observe it explicitly.
    const exited = await handle.waitForExit()
    if (!exited) throw new Error('Audio subprocess quiescence could not be confirmed.')
    if (failure) throw failure
    cancellation.signal.throwIfAborted()
    return Buffer.concat(chunks, total)
  } finally {
    cancellation.signal.removeEventListener('abort', onAbort)
  }
}

/** RMS amplitude, quantized to 0..255, over 256 equal time bins of decoded PCM. */
function pcmWaveform(pcm: Buffer): string {
  const samples = pcm.length / 2
  const bins = Buffer.alloc(256)
  for (let bin = 0; bin < bins.length; bin++) {
    const start = Math.floor(bin * samples / bins.length)
    // Sub-sample bins in very short clips use the observed nearest sample.
    const end = Math.min(samples, Math.max(start + 1, Math.floor((bin + 1) * samples / bins.length)))
    let squares = 0
    for (let sample = start; sample < end; sample++) squares += (pcm.readInt16LE(sample * 2) / 32768) ** 2
    bins[bin] = Math.min(255, Math.round(255 * Math.sqrt(squares / (end - start))))
  }
  return bins.toString('base64')
}

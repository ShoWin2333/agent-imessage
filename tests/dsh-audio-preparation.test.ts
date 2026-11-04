import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prepareVoiceMedia, type VoicePreparationServices, type VoiceSubprocessHandle,
} from '../src/plugin/audio-preparation.js'
import { DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, type OutboundMediaPayload } from '../src/media.js'

const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(16)])
const media: OutboundMediaPayload = { bytes: Buffer.from('approved audio bytes'), name: 'clip.wav', mimeType: 'audio/wav' }
function pcm(samples: number, sample: (i: number) => number = () => 0) {
  const bytes = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(sample(i), i * 2)
  return bytes
}
interface ProcessPlan { output?: readonly Buffer[]; exitCode?: number; error?: Error; hang?: boolean; inputError?: boolean; missingPipe?: boolean }
function harness(plans: ProcessPlan[] = [{ output: [ogg] }, { output: [pcm(8000)] }]) {
  const handles: Array<VoiceSubprocessHandle & { received: Buffer[]; terminated: boolean; drained: boolean }> = []
  const subprocess = {
    resolveExecutable: vi.fn(async () => '/provider/bin/ffmpeg'),
    spawn: vi.fn((_spec: Parameters<NonNullable<VoicePreparationServices['subprocess']>['spawn']>[0]) => {
      const plan = plans[handles.length] ?? {}
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const received: Buffer[] = []
      let resolve!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
      let reject!: (error: Error) => void
      const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((yes, no) => { resolve = yes; reject = no })
      const finish = () => {
        for (const bytes of plan.output ?? []) stdout.write(bytes)
        // Verbose diagnostics must be drained but not surfaced/retained.
        stderr.write(Buffer.alloc(128 * 1024, 1))
        stdout.end()
        stderr.end()
        if (plan.error) reject(plan.error)
        else resolve({ exitCode: plan.exitCode ?? 0, signal: null })
      }
      const stdin = new Writable({
        write(chunk, _encoding, callback) {
          received.push(Buffer.from(chunk))
          callback(plan.inputError ? new Error('broken input') : undefined)
        },
        final(callback) { callback(); if (!plan.hang) queueMicrotask(finish) },
      })
      const handle = {
        stdin, stdout: plan.missingPipe ? undefined : stdout, stderr, done, received,
        terminated: false, drained: false,
        terminate: vi.fn(() => {
          handle.terminated = true
          // Provider teardown closes remaining output and settles done. queued
          // output on cancellation must still be consumed before helper returns.
          if (!stdout.writableEnded) stdout.end(Buffer.from('tail'))
          if (!stderr.writableEnded) stderr.end(Buffer.from('tail'))
          resolve({ exitCode: null, signal: 'SIGKILL' })
        }),
        waitForExit: vi.fn(async () => {
          handle.drained = stdout.readableEnded && stderr.readableEnded
          return true
        }),
      }
      handles.push(handle)
      return handle
    }),
  }
  const sandbox = { confine: vi.fn(async (argv: readonly string[]) => ({ argv: ['sandbox-runner', ...argv] })) }
  const services = { subprocess, sandbox, policy: { mode: 'workspace-write' as const, workspaceRoot: '/provider/workspace' }, cwd: '/provider/workspace' }
  return { services, subprocess, sandbox, handles }
}
afterEach(() => vi.useRealTimers())

describe('composed native voice preparation', () => {
  it.each(['wav', 'mp3', 'm4a', 'aac', 'aiff', 'ogg'])('encodes %s bytes through confined fixed pipe-only argv and decodes real metadata', async ext => {
    const samples = pcm(8000, i => i < 4000 ? 0 : 16384)
    const { services, subprocess, sandbox, handles } = harness([{ output: [ogg] }, { output: [samples.subarray(0, 31), samples.subarray(31)] }])
    const input = { ...media, name: `hostile;$(curl nope).${ext}` }
    const result = await prepareVoiceMedia(input, services)
    expect(result.status).toBe('prepared')
    if (result.status !== 'prepared') throw new Error('Expected preparation')
    expect(result.media).toMatchObject({ name: 'hostile;$(curl nope).ogg', mimeType: 'audio/ogg', bytes: ogg })
    expect(result.media.voice?.durationSeconds).toBe(1)
    const waveform = Buffer.from(result.media.voice!.waveform, 'base64')
    expect(waveform.length).toBe(256)
    expect([...waveform.subarray(0, 128)]).toEqual(Array(128).fill(0))
    expect([...waveform.subarray(128)]).toEqual(Array(128).fill(128))
    expect(subprocess.resolveExecutable).toHaveBeenCalledWith('ffmpeg', undefined, expect.any(AbortSignal))
    expect(sandbox.confine).toHaveBeenCalledTimes(2)
    for (const call of subprocess.spawn.mock.calls) {
      const spec = call[0]
      expect(spec.argv[0]).toBe('sandbox-runner')
      expect(spec.cwd).toBe('/provider/workspace')
      expect(spec.stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      expect(spec.argv.slice(spec.argv.indexOf('-protocol_whitelist'), spec.argv.indexOf('-protocol_whitelist') + 2)).toEqual(['-protocol_whitelist', 'pipe'])
      expect(spec.argv.filter(value => value === 'pipe:0')).toHaveLength(1)
      expect(spec.argv.at(-1)).toBe('pipe:1')
      expect(spec.argv).not.toContain(input.name)
      expect(spec.argv).not.toContain('-t')
    }
    expect(Buffer.concat(handles[0]!.received)).toEqual(media.bytes)
    expect(Buffer.concat(handles[1]!.received)).toEqual(ogg)
    expect(handles.every(handle => handle.drained && !handle.terminated)).toBe(true)
    expect(input).not.toHaveProperty('voice')
  })

  it('uses 256 observed RMS bins for silence, one-sample clips, and signed full amplitude', async () => {
    for (const sample of [0, -32768, 32767]) {
      const { services } = harness([{ output: [ogg] }, { output: [pcm(1, () => sample)] }])
      const result = await prepareVoiceMedia(media, services)
      expect(result.status).toBe('prepared')
      if (result.status !== 'prepared') throw new Error('Expected preparation')
      expect(result.media.voice?.durationSeconds).toBe(1 / 8000)
      expect(Buffer.from(result.media.voice!.waveform, 'base64')).toEqual(Buffer.alloc(256, sample === 0 ? 0 : 255))
    }
  })

  it('returns explicit unchanged file fallback only for absent optional capabilities or missing ffmpeg', async () => {
    const { services, subprocess } = harness()
    for (const capability of ['subprocess', 'sandbox', 'policy'] as const) {
      const result = await prepareVoiceMedia(media, { ...services, [capability]: undefined })
      expect(result).toMatchObject({ status: 'unavailable', media, note: expect.stringMatching(/unavailable.*audio file/) })
    }
    subprocess.resolveExecutable.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
    expect(await prepareVoiceMedia(media, services)).toMatchObject({ status: 'unavailable', note: expect.stringContaining('ffmpeg executable was not found') })
    subprocess.resolveExecutable.mockRejectedValue(Object.assign(new Error('ffmpeg is not executable'), { name: 'SubprocessExecutableNotFoundError' }))
    expect(await prepareVoiceMedia(media, services)).toMatchObject({ status: 'unavailable', note: expect.stringContaining('ffmpeg executable was not found') })
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it('allows explicit full-access policy but never silently bypasses confined policy or denial', async () => {
    const { services, sandbox, subprocess } = harness()
    const denial = new Error('SANDBOX_DENIED')
    sandbox.confine.mockRejectedValue(denial)
    await expect(prepareVoiceMedia(media, services)).rejects.toBe(denial)
    expect(subprocess.spawn).not.toHaveBeenCalled()
    const full = harness()
    await prepareVoiceMedia(media, { ...full.services, sandbox: undefined, policy: { ...services.policy, mode: 'danger-full-access' } })
    expect(full.sandbox.confine).not.toHaveBeenCalled()
    expect(full.subprocess.spawn.mock.calls[0]![0].argv[0]).toBe('/provider/bin/ffmpeg')
  })

  it('does not disguise executable permission failures as unavailable', async () => {
    const { services, subprocess } = harness()
    subprocess.resolveExecutable.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(prepareVoiceMedia(media, services)).rejects.toThrow('permission denied')
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it('rejects unapproved shape, oversized input, pre-cancellation and invalid timeout before spawning', async () => {
    const { services, subprocess } = harness()
    await expect(prepareVoiceMedia({ ...media, bytes: Buffer.alloc(DEFAULT_MAX_OUTBOUND_MEDIA_BYTES + 1) }, services)).rejects.toThrow('20 MiB')
    await expect(prepareVoiceMedia({ ...media, bytes: Buffer.alloc(0) }, services)).rejects.toThrow('non-empty audio')
    await expect(prepareVoiceMedia({ ...media, mimeType: 'text/plain' }, services)).rejects.toThrow('audio')
    await expect(prepareVoiceMedia(media, services, AbortSignal.abort())).rejects.toThrow('cancelled')
    await expect(prepareVoiceMedia(media, { ...services, timeoutMs: Infinity })).rejects.toThrow('timeout')
    expect(subprocess.spawn).not.toHaveBeenCalled()
  })

  it.each([
    [{ output: [Buffer.from('not opus')] }, 'Ogg Opus'],
    [{ output: [ogg], exitCode: 1 }, 'failed'],
    [{ error: new Error('provider failure') }, 'provider failure'],
    [{ inputError: true }, 'broken input'],
    [{ missingPipe: true }, 'required audio pipes'],
  ] as const)('rejects invalid conversion or process failure and does not launch decode: %j', async (plan, message) => {
    const { services, handles, subprocess } = harness([plan])
    await expect(prepareVoiceMedia(media, services)).rejects.toThrow(message)
    expect(subprocess.spawn).toHaveBeenCalledTimes(1)
    expect(handles[0]!.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([Buffer.alloc(0), Buffer.from([1])])('rejects empty or malformed decoded PCM', async bytes => {
    const { services } = harness([{ output: [ogg] }, { output: [bytes] }])
    await expect(prepareVoiceMedia(media, services)).rejects.toThrow('invalid or empty PCM')
  })

  it.each(['encoded', 'pcm'] as const)('caps %s output, terminates and drains instead of returning truncation', async mode => {
    const plans = mode === 'encoded'
      ? [{ output: [Buffer.alloc(DEFAULT_MAX_OUTBOUND_MEDIA_BYTES + 1)] }]
      : [{ output: [ogg] }, { output: [Buffer.alloc(8000 * 2 * 600 + 2)] }]
    const { services, handles } = harness(plans)
    await expect(prepareVoiceMedia(media, services)).rejects.toThrow(mode === 'encoded' ? '20 MiB' : 'ten-minute')
    const last = handles.at(-1)!
    expect(last.terminate).toHaveBeenCalledOnce()
    expect(last.drained).toBe(true)
    expect(last.waitForExit).toHaveBeenCalledOnce()
  })

  it('kills and drains an in-flight encode on cancellation and removes abort listeners', async () => {
    const controller = new AbortController()
    const { services, handles } = harness([{ hang: true }])
    const promise = prepareVoiceMedia(media, services, controller.signal)
    await vi.waitFor(() => expect(handles).toHaveLength(1))
    controller.abort()
    await expect(promise).rejects.toThrow('cancelled')
    expect(handles[0]!.terminate).toHaveBeenCalledOnce()
    expect(handles[0]!.drained).toBe(true)
  })

  it('kills and drains a decode on the total preparation deadline', async () => {
    vi.useFakeTimers()
    const { services, handles } = harness([{ output: [ogg] }, { hang: true }])
    const promise = prepareVoiceMedia(media, { ...services, timeoutMs: 100 })
    const rejection = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(handles).toHaveLength(2)
    expect(handles[1]!.terminate).toHaveBeenCalledOnce()
    expect(handles[1]!.drained).toBe(true)
  })
})

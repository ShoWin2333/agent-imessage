import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Bytes and safe metadata for one outbound media send across the Spectrum seam. */
export interface OutboundMediaPayload {
  /** File contents already bounded by the configured size limit. */
  bytes: Buffer
  /** Basename only; never a path. */
  name: string
  /** MIME type derived from the allowed extension set. */
  mimeType: string
  /** Real audio metadata computed from decoded samples for native voice messages. */
  voice?: { durationSeconds: number; waveform: string }
}

/** Structural subset of the agent-composed fs service; opaque keys stay opaque. */
export interface OutboundMediaTarget {
  readonly displayPath: string
}
export interface OutboundMediaReader<T extends OutboundMediaTarget = OutboundMediaTarget> {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<T>
  processPath(target: T): string
  contains(parent: T, child: T): boolean
  stat(target: T, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'other'; size?: number } | undefined>
  readBytes(target: T, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
}

const IMAGE_MIME_BY_EXT = new Map<string, string>([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
])
const AUDIO_MIME_BY_EXT = new Map<string, string>([
  ['.m4a', 'audio/mp4'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'],
  ['.aif', 'audio/aiff'], ['.aiff', 'audio/aiff'], ['.aac', 'audio/aac'],
  ['.caf', 'audio/x-caf'], ['.ogg', 'audio/ogg'],
])
const FILE_MIME_BY_EXT = new Map<string, string>([
  ...IMAGE_MIME_BY_EXT, ...AUDIO_MIME_BY_EXT,
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain'], ['.md', 'text/markdown'],
  ['.csv', 'text/csv'], ['.json', 'application/json'], ['.zip', 'application/zip'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])

/** Audio extensions accepted by `send_imessage_voice`. */
export const OUTBOUND_AUDIO_EXTENSIONS = [...AUDIO_MIME_BY_EXT.keys()]
/** Default host limit for outbound media reads (20 MiB). */
export const DEFAULT_MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024

type MediaKind = 'file' | 'audio' | 'image'

/**
 * Resolve, validate, and bounded-read one workspace file. Actual agent tools must
 * supply their composed fs reader after approval; omitting it uses local Node fs
 * for existing trusted callers. Reader errors are never retried via raw fs.
 */
export async function loadOutboundMedia<T extends OutboundMediaTarget = OutboundMediaTarget>(input: {
  rawPath: string
  kind: MediaKind
  workspaceCwd: string
  maxBytes: number
  signal: AbortSignal
  reader?: OutboundMediaReader<T>
}): Promise<OutboundMediaPayload> {
  assertNotAborted(input.signal)
  const trimmed = input.rawPath.trim()
  if (!trimmed) throw new Error('A media file path is required.')
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) throw new Error('Invalid outbound media size limit.')
  const maxBytes = Math.min(input.maxBytes, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES)
  const displayName = safeName(trimmed)
  if (input.reader) {
    const reader = input.reader
    const root = await reader.resolve(input.workspaceCwd, { signal: input.signal })
    const target = await reader.resolve(trimmed, { cwd: root.displayPath, signal: input.signal })
    assertNotAborted(input.signal)
    if (!reader.contains(root, target)) throw new Error(`Media file "${displayName}" is outside the session workspace.`)
    const name = safeName(reader.processPath(target))
    const mimeType = requireMime(input.kind, name)
    const info = await reader.stat(target, input.signal)
    if (!info) throw new Error(`Media file "${name}" was not found.`)
    if (info.type !== 'file') throw new Error(`Media path "${name}" is not a regular file.`)
    if (info.size !== undefined && info.size > maxBytes) throw tooLarge(name)
    assertNotAborted(input.signal)
    const bytes = await reader.readBytes(target, input.signal, maxBytes)
    assertNotAborted(input.signal)
    if (bytes.byteLength > maxBytes) throw tooLarge(name)
    return { bytes: Buffer.from(bytes), name, mimeType }
  }

  let workspaceRoot: string
  try {
    workspaceRoot = await realpath(input.workspaceCwd)
  } catch {
    assertNotAborted(input.signal)
    throw new Error('The session workspace could not be resolved for media delivery.')
  }
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(path.resolve(workspaceRoot, trimmed))
  } catch (error) {
    assertNotAborted(input.signal)
    if (isNotFound(error)) throw new Error(`Media file "${displayName}" was not found.`)
    throw new Error(`Media file "${displayName}" could not be resolved.`)
  }
  if (!isPathInside(workspaceRoot, canonicalTarget)) {
    throw new Error(`Media file "${displayName}" is outside the session workspace.`)
  }
  const name = safeName(canonicalTarget)
  const mimeType = requireMime(input.kind, name)
  // No-follow on the leaf, canonical ancestor checks and inode comparison narrow
  // path-swap races. Portable Node lacks openat for an atomic ancestor walk.
  await assertCanonicalAncestors(workspaceRoot, canonicalTarget, input.signal)
  const before = await stat(canonicalTarget)
  if (!before.isFile()) throw new Error(`Media path "${name}" is not a regular file.`)
  if (before.size > maxBytes) throw tooLarge(name)
  assertNotAborted(input.signal)
  const handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error(`Media path "${name}" is not a regular file.`)
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Media file changed while opening.')
    await assertCanonicalAncestors(workspaceRoot, canonicalTarget, input.signal)
    if (await realpath(canonicalTarget) !== canonicalTarget) throw new Error('Media path changed while opening.')
    if (opened.size > maxBytes) throw tooLarge(name)
    const chunks: Buffer[] = []
    let total = 0
    // Read at most cap + one sentinel byte, even if the file grows after stat.
    while (true) {
      assertNotAborted(input.signal)
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      assertNotAborted(input.signal)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw tooLarge(name)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    await assertCanonicalAncestors(workspaceRoot, canonicalTarget, input.signal)
    return { bytes: Buffer.concat(chunks, total), name, mimeType }
  } finally {
    await handle.close()
  }
}

function safeName(filePath: string): string {
  // displayPath may originate in a Windows execution world on a Unix host.
  return path.posix.basename(filePath.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_')
}
function requireMime(kind: MediaKind, name: string): string {
  const ext = path.extname(name).toLowerCase()
  const mime = kind === 'file' ? FILE_MIME_BY_EXT.get(ext) ?? 'application/octet-stream'
    : (kind === 'audio' ? AUDIO_MIME_BY_EXT : IMAGE_MIME_BY_EXT).get(ext)
  if (!mime) throw new Error(`Unsupported ${kind} type for "${name}". Allowed extensions: ${[...(kind === 'audio' ? AUDIO_MIME_BY_EXT : IMAGE_MIME_BY_EXT).keys()].join(', ')}.`)
  return mime
}
async function assertCanonicalAncestors(root: string, target: string, signal: AbortSignal): Promise<void> {
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    assertNotAborted(signal)
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Media directory changed while reading.')
    if (current === root) break
    if (!isPathInside(root, current) || path.dirname(current) === current) throw new Error('Media directory is outside the session workspace.')
  }
  if (await realpath(root) !== root) throw new Error('Media workspace changed while reading.')
}
function tooLarge(name: string): Error {
  return new Error(`Media file "${name}" exceeds the outbound size limit.`)
}
function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Outbound media send was cancelled.')
}

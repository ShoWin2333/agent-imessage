import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
/** Bytes and safe metadata for one outbound media send across the Spectrum seam. */
export interface OutboundMediaPayload {
  /** File contents already bounded by the configured size limit. */
  bytes: Buffer
  /** Basename only; never a path. */
  name: string
  /** MIME type derived from the allowed extension set. */
  mimeType: string
}

const FILE_MIME_BY_EXT = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.json', 'application/json'],
  ['.zip', 'application/zip'],
])

const AUDIO_MIME_BY_EXT = new Map<string, string>([
  ['.m4a', 'audio/mp4'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.aac', 'audio/aac'],
  ['.caf', 'audio/x-caf'],
  ['.ogg', 'audio/ogg'],
])

/** Audio extensions accepted by `send_imessage_voice`. */
export const OUTBOUND_AUDIO_EXTENSIONS = [...AUDIO_MIME_BY_EXT.keys()]

/** Default host limit for outbound media reads (20 MiB). */
export const DEFAULT_MAX_OUTBOUND_MEDIA_BYTES = 20 * 1024 * 1024

/** Resolve, validate, and read one outbound media file under the session workspace. */
export async function loadOutboundMedia(input: {
  rawPath: string
  kind: 'file' | 'audio'
  workspaceCwd: string
  maxBytes: number
  signal: AbortSignal
}): Promise<OutboundMediaPayload> {
  assertNotAborted(input.signal)
  const trimmed = input.rawPath.trim()
  if (trimmed.length === 0) throw new Error('A media file path is required.')

  const displayName = path.basename(trimmed)
  const mimeType = mimeForKind(input.kind, displayName)
  if (mimeType === undefined) {
    throw new Error(
      `Unsupported audio type for "${displayName}". Allowed extensions: ${OUTBOUND_AUDIO_EXTENSIONS.join(', ')}.`,
    )
  }

  let workspaceRoot: string
  try {
    workspaceRoot = await realpath(input.workspaceCwd)
  } catch {
    throw new Error('The session workspace could not be resolved for media delivery.')
  }

  const resolved = path.resolve(workspaceRoot, trimmed)
  let canonicalTarget: string
  try {
    canonicalTarget = await realpath(resolved)
  } catch (error) {
    assertNotAborted(input.signal)
    if (isNotFound(error)) throw new Error(`Media file "${displayName}" was not found.`)
    throw new Error(`Media file "${displayName}" could not be resolved.`)
  }

  if (!isPathInside(workspaceRoot, canonicalTarget)) {
    throw new Error(`Media file "${displayName}" is outside the session workspace.`)
  }

  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(canonicalTarget)
  } catch (error) {
    assertNotAborted(input.signal)
    if (isNotFound(error)) throw new Error(`Media file "${displayName}" was not found.`)
    throw new Error(`Media file "${displayName}" could not be read.`)
  }

  if (!info.isFile()) {
    throw new Error(`Media path "${displayName}" is not a regular file.`)
  }
  if (info.size > input.maxBytes) {
    throw new Error(`Media file "${displayName}" exceeds the outbound size limit.`)
  }

  assertNotAborted(input.signal)
  let bytes: Buffer
  try {
    bytes = await readFile(canonicalTarget, { signal: input.signal })
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      throw new Error('Outbound media send was cancelled.')
    }
    if (isNotFound(error)) throw new Error(`Media file "${displayName}" was not found.`)
    throw new Error(`Media file "${displayName}" could not be read.`)
  }

  if (bytes.byteLength > input.maxBytes) {
    throw new Error(`Media file "${displayName}" exceeds the outbound size limit.`)
  }

  return {
    bytes,
    name: path.basename(canonicalTarget),
    mimeType,
  }
}

function mimeForKind(kind: 'file' | 'audio', fileName: string): string | undefined {
  const ext = path.extname(fileName).toLowerCase()
  return kind === 'file'
    ? FILE_MIME_BY_EXT.get(ext) ?? 'application/octet-stream'
    : AUDIO_MIME_BY_EXT.get(ext)
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError'
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Outbound media send was cancelled.')
}

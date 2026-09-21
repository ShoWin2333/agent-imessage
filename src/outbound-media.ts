import { realpath, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'

/** Bytes and safe metadata for one outbound media send across the Spectrum seam. */
export interface OutboundMediaPayload {
  /** File contents already bounded by the configured size limit. */
  bytes: Buffer
  /** Basename only; never a path. */
  name: string
  /** MIME type derived from the allowed extension set. */
  mimeType: string
}

/** Host callbacks that bind media tools to one correlated iMessage turn. */
export interface OutboundMediaOwnership {
  /** Whether the agent's current turn was claimed from this plugin's message id. */
  ownsCurrentTurn(agent: Agent): boolean
  /** The DM channel correlated to that exact owned turn. */
  channelFor(agent: Agent): SpectrumInboundMessage | undefined
  /** Whether delivery is currently healthy enough to send media. */
  deliveryHealthy(): boolean
}

/** Options for outbound media tools. */
export interface OutboundMediaOptions {
  /** Maximum accepted file size in bytes. */
  maxOutboundMediaBytes: number
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

/** Install scoped outbound image/voice tools for one agent context. */
export class OutboundMediaTools {
  /** Construct one fail-closed media tool installer. */
  constructor(
    private readonly ownership: OutboundMediaOwnership,
    private readonly options: OutboundMediaOptions,
  ) {}

  /** Register both outbound tools; dispose removes both registrations. */
  install(agentCtx: Context): () => void {
    const disposeFile = agentCtx.tools.register(this.fileTool())
    const disposeVoice = agentCtx.tools.register(this.voiceTool())
    return () => {
      disposeVoice()
      disposeFile()
    }
  }

  private fileTool() {
    const tools = this
    return defineTool({
      name: 'send_imessage_file',
      description: 'Send an existing local file to the user as an attachment in this iMessage conversation. '
        + 'When the user asks you to send or show a file or image, call this tool instead of returning a file path. '
        + 'Pass a workspace-relative or absolute path to a regular file. The runtime verifies delivery eligibility; '
        + 'do not try to infer it yourself. Images are rendered by iMessage when their type is recognized.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to an existing file inside the session workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            mimeType: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Sent file ${value.name}` }],
      },
      execute: async (args, exec) => {
        const channel = tools.requireOwnedChannel(exec.agent)
        const media = await loadOutboundMedia({
          rawPath: args.path,
          kind: 'file',
          workspaceCwd: requireAgentCwd(exec.agent),
          maxBytes: tools.options.maxOutboundMediaBytes,
          signal: exec.signal,
        })
        await channel.sendFile(media)
        return { name: media.name, mimeType: media.mimeType }
      },
    })
  }

  private voiceTool() {
    const tools = this
    return defineTool({
      name: 'send_imessage_voice',
      description: 'Send an existing local audio file to the user as a native voice message in this iMessage conversation. '
        + 'When the user asks you to send a voice message, call this tool instead of returning a file path. '
        + 'Pass a workspace-relative or absolute path '
        + `to a regular audio file (${OUTBOUND_AUDIO_EXTENSIONS.join(', ')}). `
        + 'The runtime verifies delivery eligibility; do not try to infer it yourself. '
        + 'This tool sends an existing audio file and does not synthesize speech from text.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to an existing audio file inside the session workspace.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            mimeType: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Sent voice message ${value.name}` }],
      },
      execute: async (args, exec) => {
        const channel = tools.requireOwnedChannel(exec.agent)
        const media = await loadOutboundMedia({
          rawPath: args.path,
          kind: 'audio',
          workspaceCwd: requireAgentCwd(exec.agent),
          maxBytes: tools.options.maxOutboundMediaBytes,
          signal: exec.signal,
        })
        await channel.sendVoice(media)
        return { name: media.name, mimeType: media.mimeType }
      },
    })
  }

  private requireOwnedChannel(agent: Agent | undefined): SpectrumInboundMessage {
    if (agent === undefined) {
      throw new Error('Outbound iMessage media requires an active agent on an iMessage-owned turn.')
    }
    if (!this.ownership.ownsCurrentTurn(agent)) {
      throw new Error('Outbound iMessage media is only available during an iMessage-owned turn.')
    }
    if (!this.ownership.deliveryHealthy()) {
      throw new Error('iMessage delivery is unavailable; media was not sent.')
    }
    const channel = this.ownership.channelFor(agent)
    if (channel === undefined) {
      throw new Error('No correlated iMessage channel is available for media delivery.')
    }
    return channel
  }
}

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

function requireAgentCwd(agent: Agent | undefined): string {
  if (agent === undefined) {
    throw new Error('Outbound iMessage media requires an active agent on an iMessage-owned turn.')
  }
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new Error('The session workspace is unavailable for media delivery.')
  }
  return cwd
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  if (relative === '') return true
  if (relative === '..' || path.isAbsolute(relative)) return false
  return !relative.startsWith(`..${path.sep}`) && !relative.startsWith('../')
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

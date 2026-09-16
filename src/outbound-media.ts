import { loadOutboundMedia, OUTBOUND_AUDIO_EXTENSIONS } from './media.js'
export { loadOutboundMedia, OUTBOUND_AUDIO_EXTENSIONS, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from './media.js'
export type { OutboundMediaPayload } from './media.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SpectrumInboundMessage } from './spectrum-runtime.js'

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

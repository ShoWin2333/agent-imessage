import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

export interface ChannelMediaArgs {
  path: string
  kind: 'image' | 'file' | 'voice'
}

export interface MediaSendResult {
  delivery: 'sent' | 'uncertain'
  name: string
  bytes: number
  mode: 'image' | 'file' | 'voice'
  messageId?: string
  reason?: string
}

const mediaArgs = z.object({
  path: z.string().trim().min(1),
  kind: z.enum(['image', 'file', 'voice']),
}).strict()

/** Factory only: the owner registers this on its channel agent, never globally. */
export function channelMediaTool(send: (args: ChannelMediaArgs, exec: ToolRunContext) => Promise<MediaSendResult>) {
  return defineTool({
    name: 'channel_send_media',
    description: 'Send an existing workspace-local file to the current channel owner. This uploads the file externally. Voice may fall back to an audio file; no speech synthesis. If delivery is uncertain, do not automatically retry.',
    parameters: {
      path: { type: 'string', required: true, description: 'Existing local file within the session workspace, at most 20 MiB.' },
      kind: { type: 'string', enum: ['image', 'file', 'voice'], required: true, description: 'Send as an image, a file, or existing audio as voice.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivery: { type: 'string', enum: ['sent', 'uncertain'], required: true },
          name: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          mode: { type: 'string', enum: ['image', 'file', 'voice'], required: true },
          messageId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const parsed = mediaArgs.parse(args)
      if (exec.signal.aborted) throw new Error('Outbound media send was cancelled.')
      return send(parsed, exec)
    },
  })
}

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { InteractionScope } from '../interaction-types.js'

export type VoiceHandler = (request: InteractionScope & { callId: string; context: string }) => Promise<string>
const audioArgs = z.object({ inputId: z.string().min(1), context: z.string().trim().min(1).max(16_000) }).strict()
/** No paths, recipient, session selector or automatic project-file collection. */
export function channelAudioTool(listen: (args: z.infer<typeof audioArgs>, exec: ToolRunContext) => Promise<string>) {
  return defineTool({
    name: 'channel_listen_audio',
    description: 'Send the current channel input recording to the configured audio model. The DSH model itself cannot hear audio. Provide only the minimal relevant project instructions, current conversation history and accompanying user text as context; never include secrets or unrelated content. The audio model response is stored in this session and its voice is sent to this channel. Do not retry uncertain delivery.',
    parameters: {
      inputId: { type: 'string', required: true, description: 'Exact inputId from the current audio message.' },
      context: { type: 'string', required: true, description: 'Minimal relevant context and user request, at most 16000 characters.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (value, exec) => listen(audioArgs.parse(value), exec),
  })
}

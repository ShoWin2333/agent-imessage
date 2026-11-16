import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { InteractionScope } from '../interaction-types.js'

export type VoiceHandler = (request: InteractionScope & { callId: string; context: string }) => Promise<string>
const audioArgs = z.object({ inputId: z.string().min(1), context: z.string().trim().min(1).max(16_000) }).strict()
/** No paths, recipient, session selector or automatic project-file collection. */
export function channelAudioTool(listen: (args: z.infer<typeof audioArgs>, exec: ToolRunContext) => Promise<string>) {
  return defineTool({
    name: 'channel_listen_audio',
    description: 'Understand the current real recording with the minimal relevant project/conversation context (never secrets or unrelated files). Returns internal user intent and audible observations, not an executed action or a user reply. It never sends messages. The original Agent must execute required tools and compose a concise final reply script from actual results (at most 4096 characters); the channel then synthesizes and delivers that final script once. No paths, recipients or other-session selectors.',
    parameters: {
      inputId: { type: 'string', required: true, description: 'Exact inputId from the current audio message.' },
      context: { type: 'string', required: true, description: 'Minimal relevant context and user request, at most 16000 characters.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (value, exec) => listen(audioArgs.parse(value), exec),
  })
}

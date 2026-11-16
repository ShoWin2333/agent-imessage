import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
export type ReplyMode = 'text' | 'voice'
export type ReplyModeHandler = (mode: ReplyMode) => string
const argsSchema = z.object({ inputId: z.string().min(1), mode: z.enum(['text', 'voice']) }).strict()
export function channelReplyModeTool(select: (args: z.infer<typeof argsSchema>, exec: ToolRunContext) => string) {
  return defineTool({
    name: 'channel_set_reply_mode',
    description: 'Select text or voice for the final reply to this channel input, independently of whether the user sent text or audio. Explicit user preference takes priority over the channel default. This does not reply or execute the user task: finish actual tools first, then compose the final answer. Voice synthesis occurs only after the Agent turn completes.',
    parameters: { inputId: { type: 'string', required: true }, mode: { type: 'string', enum: ['text', 'voice'], required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args, exec) => select(argsSchema.parse(args), exec),
  })
}

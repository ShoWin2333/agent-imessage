import { z } from 'zod'
import { channelSchema } from '../channels/config.js'
const reference = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
export const bindingSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  enabled: z.boolean().default(false),
  model: z.object({provider:z.string().min(1),model:z.string().min(1),reasoningEffort:z.string().min(1).optional()}).strict().optional(),
  cwd: z.string().startsWith('/'),
  channel: channelSchema,
  credentialRef: reference,
  // Required deliberately: select a preset already configured in the DSH host.
  permissionPreset: z.string().min(1),
  weixin: z.object({ ownerUserId: z.string().min(1), baseUrl: z.string().url() }).strict().optional(),
}).strict().superRefine((binding, ctx) => {
  const channel = binding.channel
  if (channel.kind === 'weixin' && !binding.weixin) ctx.addIssue({ code: 'custom', message: 'Weixin requires the existing owner and API origin' })
  if (channel.kind === 'discord' && (Boolean(channel.guildId) !== Boolean(channel.channelId) || channel.botId === channel.ownerUserId)) ctx.addIssue({ code: 'custom', message: 'Invalid Discord owner/channel binding' })
})
export const pluginConfigSchema = z.object({ bindings: z.array(bindingSchema).max(32).default([]) }).strict().superRefine((config, ctx) => {
  if (new Set(config.bindings.map(b => b.id)).size !== config.bindings.length) ctx.addIssue({ code: 'custom', message: 'Duplicate binding id' })
  const consumers = config.bindings.map(b => {
    const c = b.channel
    return JSON.stringify(c.kind === 'imessage' ? [c.kind, c.projectId] : c.kind === 'weixin' ? [c.kind, c.accountId] : [c.kind, c.botId])
  })
  if (new Set(consumers).size !== consumers.length) ctx.addIssue({ code: 'custom', message: 'One consumer per external account/project is required' })
})
export type Binding = z.output<typeof bindingSchema>

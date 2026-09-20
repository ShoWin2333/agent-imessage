import { isAbsolute } from 'node:path'
import { scheduleSchema } from './cron.js'
import { z } from 'zod'

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/)
const env = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
export const channelSchema = z.discriminatedUnion('kind', [
  z.object({ id: identifier, kind: z.literal('imessage'), projectId: z.string().min(1), projectSecretEnv: env,
    senderPhoneNumber: phone, assignedPhoneNumber: phone }).strict(),
  z.object({ id: identifier, kind: z.literal('weixin'), accountId: z.string().min(1).max(256) }).strict(),
])
export type ChannelConfig = z.infer<typeof channelSchema>

export const routeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  cwd: z.string().refine(isAbsolute, 'Use an absolute workspace directory'),
  projectId: z.string().default(''),
  projectSecretEnv: z.string().default(''),
  senderPhoneNumber: z.string().default(''),
  assignedPhoneNumber: z.string().default(''),
  schedules: z.array(scheduleSchema).max(16).optional(),
  channels: z.array(channelSchema).max(8).optional(),
  backend: z.enum(['codex', 'cursor', 'dsh']).optional(),
  approvalPolicy: z.enum(['default', 'on-request', 'never', 'deny', 'auto-review', 'unrestricted']).optional(),
  cursorSettings: z.enum(['project', 'project-user', 'none']).optional(),
  cursorMode: z.enum(['agent', 'plan', 'ask']).optional(),
  model: z.string().min(1).optional(),
  label: z.string().max(160).optional(),
  avatar: z.string().max(16_000).regex(/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/).optional(),
  enabled: z.boolean().optional(),
  effort: z.enum(['default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  speed: z.enum(['default', 'fast', 'standard']).optional(),
  cursorApiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),

}).strict().superRefine((route, ctx) => {
  const schedules = route.schedules ?? []
  if (new Set(schedules.map(s => s.id)).size !== schedules.length) ctx.addIssue({code:'custom',path:['schedules'],message:'Schedule IDs must be unique'})
  const channelIds = route.channels?.map(c => c.id) ?? ['imessage']
  if (schedules.some(s => !channelIds.includes(s.channelId))) ctx.addIssue({code:'custom',path:['schedules'],message:'Schedule must target an existing project channel'})
  if (!route.channels) {
    const result = channelSchema.safeParse({kind:'imessage', id:'imessage', projectId:route.projectId,
      projectSecretEnv:route.projectSecretEnv, senderPhoneNumber:route.senderPhoneNumber, assignedPhoneNumber:route.assignedPhoneNumber})
    if (!result.success) ctx.addIssue({code:'custom', message:'Configure an iMessage route or at least one channel'})
  } else if (!route.channels.length && route.enabled !== false) {
    ctx.addIssue({code:'custom', message:'A project without channels must be disabled'})
  } else if (new Set(route.channels.map(c => c.id)).size !== route.channels.length) {
    ctx.addIssue({code:'custom', message:'Channel IDs must be unique within a project'})
  }
})
export type RouteConfig = z.infer<typeof routeSchema>

/** Legacy routes retain their exact state identity and credential key. */
export function routeChannels(route: RouteConfig): ChannelConfig[] {
  return route.channels ?? [{kind:'imessage', id:'imessage', projectId:route.projectId,
    projectSecretEnv:route.projectSecretEnv, senderPhoneNumber:route.senderPhoneNumber, assignedPhoneNumber:route.assignedPhoneNumber}]
}
export function photonSecretKey(route: RouteConfig, channel: ChannelConfig): string {
  return route.channels ? `${route.id}:${channel.id}` : route.id
}

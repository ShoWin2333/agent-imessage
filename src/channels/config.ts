import { z } from 'zod'

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/)
/** Discord IDs are unsigned 64-bit snowflakes; keep them as strings. */
export const discordId = z.string().refine(value => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n)
export const channelSchema = z.discriminatedUnion('kind', [
  z.object({
    id: identifier, kind: z.literal('imessage'), projectId: z.string().min(1),
    senderPhoneNumber: phone, assignedPhoneNumber: phone
  }).strict(),
  z.object({ id: identifier, kind: z.literal('telegram'), botId: z.string().regex(/^[1-9]\d{0,15}$/), ownerUserId: z.string().regex(/^[1-9]\d{0,15}$/) }).strict(),
  z.object({ id: identifier, kind: z.literal('weixin'), accountId: z.string().min(1).max(256) }).strict(),
  z.object({
    id: identifier, kind: z.literal('discord'), botId: discordId, ownerUserId: discordId,
    guildId: discordId.optional(), channelId: discordId.optional()
  }).strict(),
])
export type ChannelConfig = z.infer<typeof channelSchema>


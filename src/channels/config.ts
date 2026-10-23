import { z } from 'zod'
import { IDENTIFIER_RE, PHONE_RE, SNOWFLAKE_RE, TELEGRAM_ID_RE } from '../shared/rules.js'

const identifier = z.string().regex(IDENTIFIER_RE)
const phone = z.string().regex(PHONE_RE)
/** Discord IDs are unsigned 64-bit snowflakes; keep them as strings. */
export const discordId = z.string().refine(value => SNOWFLAKE_RE.test(value) && BigInt(value) <= 18446744073709551615n)
export const channelSchema = z.discriminatedUnion('kind', [
  z.object({
    id: identifier, kind: z.literal('imessage'), projectId: z.string().min(1),
    senderPhoneNumber: phone, assignedPhoneNumber: phone
  }).strict(),
  z.object({ id: identifier, kind: z.literal('telegram'), botId: z.string().regex(TELEGRAM_ID_RE), ownerUserId: z.string().regex(TELEGRAM_ID_RE) }).strict(),
  z.object({ id: identifier, kind: z.literal('weixin'), accountId: z.string().min(1).max(256) }).strict(),
  z.object({
    id: identifier, kind: z.literal('discord'), botId: discordId, ownerUserId: discordId,
    guildId: discordId.optional(), channelId: discordId.optional()
  }).strict(),
])
export type ChannelConfig = z.infer<typeof channelSchema>

import { z } from 'zod'
import { IDENTIFIER_RE, PHONE_RE, TELEGRAM_ID_RE } from '../shared/rules.js'

const identifier = z.string().regex(IDENTIFIER_RE)
const phone = z.string().regex(PHONE_RE)
export const channelSchema = z.discriminatedUnion('kind', [
  z.object({
    id: identifier, kind: z.literal('imessage'), projectId: z.string().min(1),
    senderPhoneNumber: phone, assignedPhoneNumber: phone
  }).strict(),
  z.object({ id: identifier, kind: z.literal('telegram'), botId: z.string().regex(TELEGRAM_ID_RE), ownerUserId: z.string().regex(TELEGRAM_ID_RE) }).strict(),
  z.object({ id: identifier, kind: z.literal('weixin'), accountId: z.string().min(1).max(256) }).strict(),
  z.object({id:identifier,kind:z.literal('qqbot'),appId:z.string().regex(/^[1-9]\d{3,31}$/),ownerUserId:z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),streaming:z.boolean().default(true),showToolResults:z.boolean().default(false),sendPresentedFiles:z.boolean().default(true),maxFiles:z.number().int().min(1).max(32).default(4),externalTurns:z.enum(['off','c2c']).default('c2c'),visionProvider:z.string().min(1).optional(),visionModel:z.string().min(1).optional(),
    // Upgrade-only private fields from .17; no group target is accepted.
    scope:z.literal('c2c').optional(),requireMention:z.boolean().optional(),
  }).strict(),
], {error:'Unsupported channel kind; only imessage, telegram, weixin and qqbot are supported'}).transform(channel=>{
  if(channel.kind!=='qqbot')return channel
  const {scope:_scope,requireMention:_mention,...privateChannel}=channel
  return privateChannel
})
export type ChannelConfig = z.infer<typeof channelSchema>

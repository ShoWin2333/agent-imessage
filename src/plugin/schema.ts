import Schema from '@deepseek-ai/schemastery'
import { absoluteWorkspacePattern } from './workspace-path.js'

const id = () => Schema.string().pattern(/^[A-Za-z0-9_-]{1,64}$/).required()
const text = () => Schema.string().min(1).required()
const numeric = () => Schema.string().pattern(/^[1-9]\d{0,15}$/).required()
const snowflake = () => Schema.string().pattern(/^[1-9]\d{0,19}$/).required()
const phone = () => Schema.string().pattern(/^\+[1-9]\d{6,14}$/).required()
const channels = Schema.union([
  Schema.object({ id:id(), kind:Schema.const('imessage').required(), projectId:text(), senderPhoneNumber:phone(), assignedPhoneNumber:phone() }),
  Schema.object({ id:id(), kind:Schema.const('telegram').required(), botId:numeric(), ownerUserId:numeric() }),
  Schema.object({ id:id(), kind:Schema.const('weixin').required(), accountId:Schema.string().min(1).max(256).required() }),
  Schema.object({ id:id(), kind:Schema.const('discord').required(), botId:snowflake(), ownerUserId:snowflake(), guildId:snowflake().required(false), channelId:snowflake().required(false) }),
]).required()
const binding = Schema.object({
  id:id(), enabled:Schema.boolean().default(false), cwd:Schema.string().pattern(absoluteWorkspacePattern).required(),
  credentialRef:Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).required(), permissionPreset:text(), channel:channels,
  model:Schema.object({provider:text(),model:text(),reasoningEffort:Schema.string().min(1)}).extra('default', undefined),
  weixin:Schema.object({ownerUserId:text(),baseUrl:Schema.string().pattern(/^https?:\/\/[^\s]+$/).required()}).extra('default', undefined),
})
// Native Settings reserializes this schema before sending it to the browser.
// Keep it declarative: executable transform callbacks do not survive that round trip.
const bindings = Schema.array(binding).max(32).default([]).volatile()
export const Config: Schema = Schema.object({ bindings })

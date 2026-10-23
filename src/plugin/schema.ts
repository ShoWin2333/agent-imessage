import Schema from '@deepseek-ai/schemastery'
import { absoluteWorkspacePattern } from './workspace-path.js'
import { CREDENTIAL_RE, IDENTIFIER_RE, ORIGIN_RE, PHONE_RE, SNOWFLAKE_RE, TELEGRAM_ID_RE } from '../shared/rules.js'

const id = () => Schema.string().pattern(IDENTIFIER_RE).required()
const text = () => Schema.string().min(1).required()
const numeric = () => Schema.string().pattern(TELEGRAM_ID_RE).required()
const snowflake = () => Schema.string().pattern(SNOWFLAKE_RE).required()
const phone = () => Schema.string().pattern(PHONE_RE).required()
const channels = Schema.union([
  Schema.object({ id:id(), kind:Schema.const('imessage').required(), projectId:text(), senderPhoneNumber:phone(), assignedPhoneNumber:phone() }),
  Schema.object({ id:id(), kind:Schema.const('telegram').required(), botId:numeric(), ownerUserId:numeric() }),
  Schema.object({ id:id(), kind:Schema.const('weixin').required(), accountId:Schema.string().min(1).max(256).required() }),
  Schema.object({ id:id(), kind:Schema.const('discord').required(), botId:snowflake(), ownerUserId:snowflake(), guildId:snowflake().required(false), channelId:snowflake().required(false) }),
]).required()
const binding = Schema.object({
  id:id(), enabled:Schema.boolean().default(false), cwd:Schema.string().pattern(absoluteWorkspacePattern).required(),
  credentialRef:Schema.string().pattern(CREDENTIAL_RE).required(), permissionPreset:text(), channel:channels,
  model:Schema.object({provider:text(),model:text(),reasoningEffort:Schema.string().min(1)}).extra('default', undefined),
  weixin:Schema.object({ownerUserId:text(),baseUrl:Schema.string().pattern(ORIGIN_RE).required()}).extra('default', undefined),
})
// Native Settings reserializes this schema before sending it to the browser.
// Keep it declarative: executable transform callbacks do not survive that round trip.
const bindings = Schema.array(binding).max(32).default([]).volatile()
export const Config: Schema = Schema.object({ bindings })

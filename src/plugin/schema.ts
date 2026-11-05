import Schema from '@deepseek-ai/schemastery'
import { absoluteWorkspacePattern } from './workspace-path.js'
import { CREDENTIAL_RE, IDENTIFIER_RE, ORIGIN_RE, PHONE_RE, TELEGRAM_ID_RE } from '../shared/rules.js'
import {MAX_AGENTS} from '../shared/agents.js'

const id = () => Schema.string().pattern(IDENTIFIER_RE).required()
const text = () => Schema.string().min(1).required()
const numeric = () => Schema.string().pattern(TELEGRAM_ID_RE).required()
const phone = () => Schema.string().pattern(PHONE_RE).required()
const qqid=()=>Schema.string().pattern(/^[A-Za-z0-9_-]{8,128}$/).required()
const channels = Schema.union([
  Schema.object({ id:id(), kind:Schema.const('imessage').required(), projectId:text(), senderPhoneNumber:phone(), assignedPhoneNumber:phone() }),
  Schema.object({ id:id(), kind:Schema.const('telegram').required(), botId:numeric(), ownerUserId:numeric() }),
  Schema.object({ id:id(), kind:Schema.const('weixin').required(), accountId:Schema.string().min(1).max(256).required() }),
  Schema.object({id:id(),kind:Schema.const('qqbot').required(),appId:Schema.string().pattern(/^[1-9]\d{3,31}$/).required(),ownerUserId:qqid(),streaming:Schema.boolean().default(true),showToolResults:Schema.boolean().default(false),sendPresentedFiles:Schema.boolean().default(true),maxFiles:Schema.number().min(1).max(32).step(1).default(4),externalTurns:Schema.union(['off','c2c']).default('c2c'),visionProvider:Schema.string().min(1),visionModel:Schema.string().min(1)}),
]).required()
const binding = Schema.object({
  id:id(), enabled:Schema.boolean().default(false), cwd:Schema.string().pattern(absoluteWorkspacePattern).required(),
  credentialRef:Schema.string().pattern(CREDENTIAL_RE).required(), permissionPreset:text(), channel:channels,
  // Accepted for upgrades only. The approval router ignores this former exception.
  directTelegramVoice:Schema.boolean().required(false),
  model:Schema.object({provider:text(),model:text(),reasoningEffort:Schema.string().min(1)}).extra('default', undefined),
  weixin:Schema.object({ownerUserId:text(),baseUrl:Schema.string().pattern(ORIGIN_RE).required()}).extra('default', undefined),
})
// Native Settings reserializes this schema before sending it to the browser.
// Keep it declarative: executable transform callbacks do not survive that round trip.
const bindings = Schema.array(binding).max(32).default([]).volatile()
const agents=Schema.array(Schema.object({id:id(),name:Schema.string().min(1).max(80).required(),cwd:Schema.string().pattern(absoluteWorkspacePattern).required(),bindingIds:Schema.array(id()).max(32).default([])})).max(MAX_AGENTS).default([]).volatile()
export const Config: Schema = Schema.object({ bindings, agents })

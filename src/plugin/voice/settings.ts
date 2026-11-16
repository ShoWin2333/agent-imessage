import { z } from 'zod'
import { ORIGIN_RE } from '../../shared/rules.js'

/** Empty is allowed so a saved draft can exist before the key is entered. */
const OPTIONAL_CREDENTIAL = /^$|^[A-Za-z_][A-Za-z0-9_]*$/
const MODEL_NAME = /^[A-Za-z0-9._:-]{1,80}$/

/**
 * Deployment-wide speech settings. One key serves every channel binding, which
 * matches how a learner configures a single provider account.
 */
export const voiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  replyMode: z.enum(['text', 'voice']).default('text'),
  credentialRef: z.string().regex(OPTIONAL_CREDENTIAL).default(''),
  baseURL: z.string().regex(ORIGIN_RE).default('https://api.openai.com/v1'),
  /** Audio understanding model; it receives real audio, not an ASR replacement. */
  model: z.string().regex(MODEL_NAME).default('gpt-audio'),
  speechModel: z.string().regex(MODEL_NAME).default('gpt-4o-mini-tts'),
  voice: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/).default('alloy'),
  /** Optional system prompt; empty sends none, so the model answers naturally. */
  instructions: z.string().max(4000).default(''),
}).strict()

export type VoiceConfig = z.output<typeof voiceConfigSchema>

export const DEFAULT_VOICE_CONFIG: VoiceConfig = voiceConfigSchema.parse({})

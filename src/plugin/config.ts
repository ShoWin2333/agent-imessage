import { z } from 'zod'
import { channelSchema } from '../channels/config.js'
import { absoluteWorkspacePattern } from './workspace-path.js'
import { bindingIssues, CREDENTIAL_RE, IDENTIFIER_RE, MAX_BINDINGS, ORIGIN_RE } from '../shared/rules.js'

const reference = z.string().regex(CREDENTIAL_RE)
export const bindingSchema = z.object({
  id: z.string().regex(IDENTIFIER_RE),
  enabled: z.boolean().default(false),
  model: z.object({ provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().min(1).optional() }).strict().optional(),
  cwd: z.string().regex(absoluteWorkspacePattern),
  channel: channelSchema,
  credentialRef: reference,
  // Required deliberately: select a preset already configured in the DSH host.
  permissionPreset: z.string().min(1),
  weixin: z.object({ ownerUserId: z.string().min(1), baseUrl: z.string().regex(ORIGIN_RE) }).strict().optional(),
}).strict()

/**
 * Structure stays declarative so the native Settings page can reserialize it.
 * Cross-field meaning comes from the shared rules module, which the settings
 * panel also uses, so a saved draft cannot pass one validator and fail the other.
 */
export const pluginConfigSchema = z.object({ bindings: z.array(bindingSchema).max(MAX_BINDINGS).default([]) }).strict().superRefine((config, ctx) => {
  for (const issue of bindingIssues(config.bindings)) {
    ctx.addIssue({
      code: 'custom',
      path: issue.bindingId === undefined ? [] : ['bindings', config.bindings.findIndex(binding => binding.id === issue.bindingId)],
      message: [issue.code, issue.bindingId, issue.field].filter((part): part is string => part !== undefined).join(':'),
    })
  }
})
export type Binding = z.output<typeof bindingSchema>

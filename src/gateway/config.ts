import { isAbsolute } from 'node:path'
import { z } from 'zod'

export const routeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  cwd: z.string().refine(isAbsolute, 'Use an absolute workspace directory'),
  projectId: z.string().min(1),
  projectSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  senderPhoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  assignedPhoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  backend: z.enum(['codex', 'cursor', 'dsh']).optional(),
  approvalPolicy: z.enum(['default', 'on-request', 'never', 'deny', 'auto-review', 'unrestricted']).optional(),
  cursorSettings: z.enum(['project', 'project-user', 'none']).optional(),
  cursorMode: z.enum(['agent', 'plan', 'ask']).optional(),
  model: z.string().min(1).optional(),
  label: z.string().max(160).optional(),
  enabled: z.boolean().optional(),
  effort: z.enum(['default', 'low', 'medium', 'high', 'xhigh']).optional(),
  speed: z.enum(['default', 'fast', 'standard']).optional(),
  cursorApiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),

}).strict()
export type RouteConfig = z.infer<typeof routeSchema>

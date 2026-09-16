import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const routeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  cwd: z.string().refine(isAbsolute, 'Use an absolute workspace directory'),
  projectId: z.string().min(1),
  projectSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  senderPhoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  assignedPhoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/),
  model: z.string().min(1).optional(),
}).strict()
const schema = z.object({
  codexBinary: z.string().min(1).default('codex'),
  stateDir: z.string().refine(isAbsolute, 'Use an absolute state directory'),
  routes: z.array(routeSchema).min(1).max(16),
}).strict()
export type RouteConfig = z.infer<typeof routeSchema>
export type BridgeConfig = z.infer<typeof schema>

export async function loadConfig(file: string): Promise<BridgeConfig> {
  const parsed = schema.safeParse(JSON.parse(await readFile(file, 'utf8')))
  if (!parsed.success) throw new Error('Invalid config: check required fields and absolute paths in the example')
  const config = parsed.data
  const ids = new Set<string>()
  const projects = new Set<string>()
  for (const route of config.routes) {
    if (ids.has(route.id) || projects.has(route.projectId)) throw new Error('Each route requires a unique id and Photon project')
    ids.add(route.id); projects.add(route.projectId)
    route.cwd = await realpath(route.cwd)
    if (!(await stat(route.cwd)).isDirectory()) throw new Error('Workspace must be a directory')
    if (!process.env[route.projectSecretEnv]) throw new Error(`Missing environment variable: ${route.projectSecretEnv}`)
  }
  return config
}

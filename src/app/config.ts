import { mkdir, readFile, writeFile, rename, rm, realpath, stat, lstat } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { PluginError } from '../errors.js'
import { z } from 'zod'
import { routeSchema, routeChannels } from '../gateway/config.js'
import { parsePhotonCredential } from '../credential.js'
import { StateStore } from '../gateway/state.js'
import { object, type ObjectValue } from '../backends/jsonrpc.js'

export const defaultConfigFile = join(homedir(), '.config/agent-imessage/config.json')
export const appSchema = z.object({
  version: z.literal(1).default(1),
  port: z.number().int().min(0).max(65535).default(8787),
  stateDir: z.string().refine(isAbsolute).default(join(homedir(), '.local/state/agent-imessage')),
  codexBinary: z.string().min(1).default('codex'),
  dshBinary: z.string().min(1).default('dsh'),
  routes: z.array(routeSchema).max(16).default([]),
}).strict()
export type AppConfig = z.infer<typeof appSchema>
export interface WeixinCredential { token: string; accountId: string; ownerUserId: string; baseUrl: string }
export interface Secrets { photonAccounts?: Record<string,{secret:string;assignedPhoneNumber:string;senderPhoneNumber:string}> | undefined; telegramAccounts?: Record<string, {ownerUserId: string; username: string}> | undefined; telegram?: Record<string, string> | undefined; weixin?: Record<string, WeixinCredential> | undefined; cursorApiKey?: string | undefined; photon: Record<string, string> }
const secretSchema = z.object({ photonAccounts:z.record(z.string(),z.object({secret:z.string().min(1),assignedPhoneNumber:z.string(),senderPhoneNumber:z.string()})).optional(), telegramAccounts: z.record(z.string(),z.object({ownerUserId:z.string().regex(/^[1-9]\d{0,15}$/),username:z.string()})).optional(), telegram: z.record(z.string(), z.string().regex(/^[1-9]\d*:[A-Za-z0-9_-]+$/)).optional(), weixin: z.record(z.string(), z.object({token:z.string().min(1),accountId:z.string().min(1),ownerUserId:z.string().min(1),baseUrl:z.string().url()})).optional(), cursorApiKey: z.string().optional(), photon: z.record(z.string(), z.string()) })

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const info = await lstat(dirname(file))
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Configuration directory must be private (chmod 700)')
  const temp = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
  finally { await rm(temp, { force: true }) }
}
export async function validateConfig(value: unknown, resolveWorkspaces = true): Promise<AppConfig> {
  const raw = object(value)
  // Older installations may still store the removed per-project proxy setting.
  const migrated = Array.isArray(raw.routes) ? {...raw, routes:raw.routes.map(route => {
    if (!Object.hasOwn(object(route), 'cursorProxyUrl')) return route
    const copy = {...object(route)}
    delete copy.cursorProxyUrl
    return copy
  })} : value
  const parsed = appSchema.safeParse(migrated)
  if (!parsed.success) {
    if (parsed.error.issues.some(issue => issue.path.includes('schedules'))) throw new PluginError('invalid-command','定时任务配置无效：请填写名称和任务内容，使用有效的五段 Cron、IANA 时区及本项目入口；任务 ID 不可重复。')
    throw new Error('Invalid config: check fields, absolute paths and E.164 numbers')
  }
  const config = parsed.data
  const ids = new Set(), projects = new Set(), addresses = new Set()
  const weixinOwners = new Map<string, string>()
  for (const route of config.routes) {
    if (ids.has(route.id)) throw new Error('Routes need unique IDs')
    ids.add(route.id)
    for (const channel of routeChannels(route)) {
      if (channel.kind === 'weixin') {
        const owner = weixinOwners.get(channel.accountId)
        if (owner) throw new Error(`WeChat 机器人必须唯一绑定（unique）：已绑定「${owner}」，请先在原项目解绑并保存，再绑定「${route.label || route.id}」。停止项目不会释放绑定。`)
        weixinOwners.set(channel.accountId, route.label || route.id)
      }
      const project = channel.kind === 'imessage' ? `imessage:${channel.projectId}` : channel.kind === 'telegram' ? `telegram:${channel.botId}` : `weixin:${channel.accountId}`
      const address = channel.kind === 'imessage' ? `${channel.senderPhoneNumber}:${channel.assignedPhoneNumber}` : project
      if (projects.has(project) || addresses.has(address)) throw new Error('Message accounts and sender/recipient pairs must be unique across projects')
      projects.add(project); addresses.add(address)
    }
    if (route.backend === 'cursor' && !route.model && ((route.effort && route.effort !== 'default') || (route.speed && route.speed !== 'default'))) throw new Error('Specify a Cursor model when overriding effort or speed')
    const allowed = route.backend === 'cursor' ? ['default','auto-review','unrestricted'] : route.backend === 'dsh' ? ['default','deny'] : ['default','on-request','auto-review','never']
    if (!allowed.includes(route.approvalPolicy ?? 'default')) throw new Error('Unsupported approval policy for backend')
    if (route.backend === 'dsh' && route.speed && route.speed !== 'default') throw new Error('DSH does not expose a speed option')
    if (route.cursorMode && route.backend !== 'cursor') throw new Error('cursorMode requires Cursor')
    if (resolveWorkspaces) {
      route.cwd = await realpath(route.cwd)
      if (!(await stat(route.cwd)).isDirectory()) throw new Error('Workspace must be a directory')
    }
  }
  return config
}
export async function readJson(file: string): Promise<unknown> { return JSON.parse(await readFile(file, 'utf8')) }
export async function loadAppConfig(file: string): Promise<AppConfig> {
  let raw: unknown
  try { raw = await readJson(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return appSchema.parse({})
    throw error
  }
  const value = object(raw)
  // Legacy bridge files keep their state root, route IDs and environment references.
  if (!('version' in value)) delete value.cursorBinary
  // Workspace ENOENT is a configuration error, never a reason to reset all routes.
  return validateConfig(value, false)
}
export async function loadSecrets(file: string): Promise<Secrets> {
  try { return secretSchema.parse(await readJson(file)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { photon: {} }; throw error }
}

/** Explicit migration never overwrites source files; all routes migrate or none do. */
export async function importConfig(source: string, destination: string, credentialFile?: string): Promise<void> {
  try { await stat(destination); throw new Error('Destination exists; choose a new config path') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const raw = object(await readJson(source))
  const secrets: Secrets = { photon: {} }
  const credential = credentialFile ? parsePhotonCredential(JSON.stringify(await readJson(credentialFile))) : undefined
  const projects = credential?.projects ?? []
  const rows = Array.isArray(raw.routes) ? raw.routes.map(object) : [raw]
  const dsh = rows.some(r => 'workspaceCwd' in r)
  const cursorApp = !dsh && rows.every(row => !row.projectSecretEnv)
  const routes = []
  for (const [index, row] of rows.entries()) {
    const id = String(row.id ?? (dsh ? 'default' : 'cursor-main'))
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid route ID')
    const project = projects.find(p => p.name === row.photonProjectName)
    const route = {
      id, cwd: row.cwd ?? row.workspaceCwd,
      backend: row.backend ?? (dsh ? 'dsh' : cursorApp ? 'cursor' : 'codex'),
      projectId: row.projectId ?? project?.id,
      projectSecretEnv: row.projectSecretEnv ?? `AGENT_PHOTON_${index}`,
      senderPhoneNumber: row.senderPhoneNumber ?? row.phoneNumber,
      assignedPhoneNumber: row.assignedPhoneNumber,
      ...Object.fromEntries(['model', 'effort', 'speed', 'label', 'cursorMode'].filter(k => row[k] !== undefined).map(k => [k, row[k]])),
    }
    if (dsh && !project?.secret) throw new Error('Missing DSH project credential')
    routes.push(route)
    if (typeof project?.secret === 'string') secrets.photon[id] = project.secret
    if (cursorApp) {
      const candidates = [join(dirname(source), 'route-secrets', `${id}.photon`), ...(id === 'cursor-main' ? [join(dirname(source), 'photon.secret')] : [])]
      for (const path of candidates) {
        try { secrets.photon[id] = (await readFile(path, 'utf8')).trim(); break }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
  }
  if (cursorApp) {
    try { secrets.cursorApiKey = (await readFile(join(dirname(source), 'cursor.api-key'), 'utf8')).trim() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const config = await validateConfig({ routes, ...(raw.stateDir ? { stateDir: raw.stateDir } : {}), ...(raw.port ? { port: raw.port } : {}), ...(raw.codexBinary ? { codexBinary: raw.codexBinary } : {}) })
  // The SDK prototype used a separate route-state directory. Import only bound local
  // SDK sessions, never reinterpret old ACP IDs as SDK agent IDs.
  if (cursorApp && dirname(source) === join(homedir(), '.config/cursor-imessage-app')) {
    const legacyState = join(homedir(), '.local/state/cursor-imessage-app')
    for (const route of config.routes) {
      let value: ObjectValue
      try { value = object(await readJson(join(legacyState, `${route.id}.json`))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      const store = await StateStore.open(config.stateDir, route)
      try {
        if (Array.isArray(value.seen) && value.seen.every(id => typeof id === 'string')) store.state.seen = value.seen.slice(-1024)
        if (typeof value.agentId === 'string' && !value.agentId.startsWith('bc-')) {
          const { Agent } = await import('@cursor/sdk')
          try {
            const info = await Agent.get(value.agentId, { cwd: route.cwd })
            if (info.runtime === 'local' && info.cwd && await realpath(info.cwd) === route.cwd) {
              store.state.threadId = info.agentId
              store.state.sessions = [info.agentId]
            }
          } catch { /* Missing or unverifiable SDK session: retain source and begin fresh. */ }
        }
        await store.save()
      } finally { await store.close() }
    }
  }
  await atomicJson(`${destination}.secrets.json`, secrets)
  if (credential?.apiOrigin === 'https://app.photon.codes') await atomicJson(`${destination}.photon.json`, { accessToken: credential.accessToken, expiresAt: credential.accessTokenExpiresAt, account: credential.account })
  await atomicJson(destination, config)
}

import { Cursor } from '@cursor/sdk'
import { AppServer } from './codex.js'
import { JsonRpcProcess, object } from './jsonrpc.js'
import type { AppConfig, Secrets } from '../app/config.js'
export interface ModelChoice { id: string; name: string }
export function modelChoices(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const item = object(raw)
    if (Array.isArray(item.options)) return modelChoices(item.options).map(choice => ({...choice, name: `${String(item.name ?? item.group ?? '')} / ${choice.name}`}))
    const id = item.model ?? item.modelId ?? item.value ?? item.id
    return typeof id === 'string' ? [{ id, name: String(item.displayName ?? item.name ?? item.label ?? id) }] : []
  })
}
export async function listModels(backend: string, cwd: string, config: AppConfig, secrets: Secrets, routeId?: string): Promise<ModelChoice[]> {
  const route = config.routes.find(r => r.id === routeId)
  if (backend === 'cursor') {
    const apiKey = route?.cursorApiKeyEnv ? process.env[route.cursorApiKeyEnv] : secrets.cursorApiKey || process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error('Cursor key required')
    return modelChoices(await Cursor.models.list({ apiKey }))
  }
  const privateNames = ['CURSOR_API_KEY', ...config.routes.flatMap(r => [r.projectSecretEnv, r.cursorApiKeyEnv ?? 'CURSOR_API_KEY'])]
  if (backend === 'codex') {
    const rpc = new AppServer(config.codexBinary, cwd, privateNames)
    try {
      await rpc.initialize()
      const models: ModelChoice[] = []; let cursor: string | undefined
      do {
        const result = await rpc.request('model/list', { ...(cursor ? {cursor} : {}) })
        models.push(...modelChoices(result.data)); cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
      } while (cursor && models.length < 1000)
      return models
    } finally { rpc.close(); await rpc.waitClosed() }
  }
  if (backend !== 'dsh') throw new Error('Unknown backend')
  const rpc = new JsonRpcProcess(config.dshBinary, cwd, privateNames, {args:['--profile','acp'],jsonrpc:true,env:{DSH_PERMISSION_MODE:'workspace-write'}})
  try {
    await rpc.request('initialize', {protocolVersion:1,clientCapabilities:{},clientInfo:{name:'agent-imessage',version:'1.0.0'}})
    const session = await rpc.request('session/new', {cwd,mcpServers:[]})
    try {
      const options = Array.isArray(session.configOptions) ? session.configOptions.map(object) : []
      const model = options.find(o => o.id === 'model' || o.category === 'model')
      return modelChoices(object(session.models).availableModels ?? model?.options)
    } finally { if (typeof session.sessionId === 'string') await rpc.request('session/close', {sessionId:session.sessionId}) }
  } finally { rpc.close(); await rpc.waitClosed() }
}

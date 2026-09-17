import { Cursor } from '@cursor/sdk'
import { AppServer } from './codex.js'
import { JsonRpcProcess, object } from './jsonrpc.js'
import type { AppConfig, Secrets } from '../app/config.js'
export interface ParameterChoice { value: string; label: string }
export interface ModelChoice { id: string; name: string; efforts?: ParameterChoice[]; speeds?: ParameterChoice[] }
export function withCapabilities(raw: unknown, backend: 'cursor' | 'codex'): ModelChoice[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(value => {
    const item = object(value), choice = modelChoices([item])[0]
    if (!choice) return []
    const params = Array.isArray(item.parameters) ? item.parameters.map(object) : []
    const values = (id: string) => { const list = params.find(p => p.id === id)?.values; return Array.isArray(list) ? list.map(object) : [] }
    const efforts = backend === 'cursor' ? values('effort').map(v=>({value:String(v.value),label:String(v.displayName ?? v.value)}))
      : (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map(object) : []).map(v=>({value:String(v.reasoningEffort),label:String(v.reasoningEffort)}))
    const speeds = backend === 'cursor' ? values('fast').flatMap(v=>v.value === 'true' ? [{value:'fast',label:'快速'}] : v.value === 'false' ? [{value:'standard',label:'标准'}] : [])
      : (Array.isArray(item.serviceTiers) ? item.serviceTiers.map(object) : []).filter(v=>v.id === 'priority').map(()=>({value:'fast',label:'Fast（更多用量）'}))
    return [{...choice,efforts,speeds}]
  })
}
export function modelChoices(value: unknown): ModelChoice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(raw => {
    const item = object(raw)
    if (Array.isArray(item.options)) return modelChoices(item.options).map(choice => ({...choice, name: `${String(item.name ?? item.group ?? '')} / ${choice.name}`}))
    const id = item.model ?? item.modelId ?? item.value ?? item.id
    return typeof id === 'string' ? [{ id, name: String(item.displayName ?? item.name ?? item.label ?? id) }] : []
  })
}
export async function listModels(backend: string, cwd: string, config: AppConfig, secrets: Secrets, routeId?: string, selectedModel?: string): Promise<ModelChoice[]> {
  const route = config.routes.find(r => r.id === routeId)
  if (backend === 'cursor') {
    const apiKey = route?.cursorApiKeyEnv ? process.env[route.cursorApiKeyEnv] : secrets.cursorApiKey || process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error('Cursor key required')
    return withCapabilities(await Cursor.models.list({ apiKey }), 'cursor')
  }
  const privateNames = ['CURSOR_API_KEY', ...config.routes.flatMap(r => [r.projectSecretEnv, r.cursorApiKeyEnv ?? 'CURSOR_API_KEY'])]
  if (backend === 'codex') {
    const rpc = new AppServer(config.codexBinary, cwd, privateNames)
    try {
      await rpc.initialize()
      const models: ModelChoice[] = []; let cursor: string | undefined
      do {
        const result = await rpc.request('model/list', { ...(cursor ? {cursor} : {}) })
        models.push(...withCapabilities(result.data, 'codex')); cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
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
      const updated = selectedModel ? await rpc.request('session/set_config_option', {sessionId:session.sessionId,configId:'model',value:selectedModel}) : session
      const options = Array.isArray(updated.configOptions) ? updated.configOptions.map(object) : []
      const model = options.find(o => o.id === 'model' || o.category === 'model')
      const effort = options.find(o => o.id === 'reasoning_effort')
      const efforts = modelChoices(effort?.options).map(v=>({value:v.id,label:v.name}))
      const current = selectedModel ?? model?.currentValue
      return modelChoices(object(session.models).availableModels ?? model?.options).map(m=>({...m,speeds:[],...(m.id === current ? {efforts} : {})}))
    } finally { if (typeof session.sessionId === 'string') await rpc.request('session/close', {sessionId:session.sessionId}) }
  } finally { rpc.close(); await rpc.waitClosed() }
}

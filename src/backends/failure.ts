import type { BackendFailure } from './types.js'

/** Read only bounded error metadata. Never expose upstream messages or causes. */
export function backendFailure(error: unknown): BackendFailure {
  if (error instanceof BackendOperationError) return error.diagnostic.failure
  const parts: string[] = []
  const seen = new Set<unknown>()
  for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause) && seen.size < 5;) {
    seen.add(cause)
    const value = cause as Record<string, unknown>
    for (const key of ['name', 'code', 'message']) if (typeof value[key] === 'string') parts.push(value[key].slice(0, 4096))
    cause = value.cause
  }
  const message = parts.join(' ')
  if (/already has active run/i.test(message)) return 'session-busy'
  if (/agent_not_found|AgentNotFoundError|Agent .+ not found/i.test(message)) return 'session-not-found'
  if (/Cannot use this model|BAD_MODEL_NAME|MODEL_BLOCKED/i.test(message)) return 'model-unavailable'
  if (/SQLITE_|database (?:is )?closed|database is locked/i.test(message)) return 'local-storage'
  if (/invalid api key|unauthenticated|unauthorized|authentication failed/i.test(message)) return 'authentication'
  if (/model not available.*provider is not supported in your region|provider is not supported in your region/i.test(message)) return 'region-unavailable'
  if (/deadline.exceeded|timed? ?out|timeout/i.test(message)) return 'timeout'
  if (/rate.limit|too many requests|resource.exhausted/i.test(message)) return 'rate-limit'
  if (/aborted|aborterror|\bcancell?ed\b/i.test(message)) return 'aborted'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error|network request failed/i.test(message)) return 'network'
  return 'unknown'
}
export const failureText: Record<BackendFailure, string> = {
  'session-busy': '会话已有任务占用。可发送 /new 新建会话，或在本机处理原任务。',
  'session-not-found': '本地会话不存在，请检查工作目录和会话记录；需要新会话时再使用 /new。',
  'model-unavailable': 'SDK 模型目录不接受所选模型，请刷新模型列表并检查模型 ID 和账号权限。',
  'local-storage': '本地会话数据库不可用，请检查文件权限、磁盘和占用该会话的进程。',
  authentication: '认证失败，请检查对应 Agent 的登录或 API Key。',
  'region-unavailable': '所选模型提供商在当前账号或网络地区不可用，请检查模型和网络配置。',
  timeout: '后端报告请求超时。任务可能已执行部分操作，请检查后再决定是否重试。',
  aborted: '后端报告请求被中止；目前无法确定是网络、服务端还是 SDK 内部取消。任务未自动重试。',
  network: '后端报告连接错误。任务可能已执行部分操作，请检查后再决定是否重试。',
  'rate-limit': '后端报告限流，请稍后再试。',
  unknown: '后端未提供可识别的失败原因，请查看本机活动记录。',
}

export type BackendStage = 'initialize' | 'session-create' | 'session-resume' | 'worker-refresh' | 'turn-start' | 'turn-stream' | 'turn-wait' | 'cancel' | 'close'
export interface BackendDiagnostic {
  stage: BackendStage
  failure: BackendFailure
  causes: Array<{ name: string; code?: string; status?: number }>
}
const stages = new Set<BackendStage>(['initialize','session-create','session-resume','worker-refresh','turn-start','turn-stream','turn-wait','cancel','close'])
const names = new Set(['Error','TypeError','RangeError','AbortError','ConnectError','CursorSdkError','CursorAgentError','AuthenticationError','RateLimitError','ConfigurationError','AgentBusyError','NetworkError','UnknownAgentError','AgentNotFoundError','SqliteError'])
const codes = new Set(['agent_not_found','ECONNRESET','ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EACCES','EPERM','ENOSPC','SQLITE_BUSY','SQLITE_LOCKED','SQLITE_CANTOPEN','SQLITE_READONLY','SQLITE_FULL','SQLITE_CORRUPT','SQLITE_MISUSE','canceled','unknown','invalid_argument','deadline_exceeded','not_found','already_exists','permission_denied','resource_exhausted','failed_precondition','aborted','out_of_range','unimplemented','internal','unavailable','data_loss','unauthenticated','NOT_LOGGED_IN','INVALID_AUTH_ID','AGENT_REQUIRES_LOGIN','AUTH_TOKEN_NOT_FOUND','AUTH_TOKEN_EXPIRED','UNAUTHORIZED','BAD_API_KEY','BAD_USER_API_KEY','BAD_MODEL_NAME','MODEL_BLOCKED','TIMEOUT','RESOURCE_EXHAUSTED','RATE_LIMITED'])

/** Keep an allowlisted error chain, never arbitrary messages, stacks, IDs or URLs. */
export function backendDiagnostic(error: unknown, stage: BackendStage): BackendDiagnostic {
  if (error instanceof BackendOperationError) return error.diagnostic
  const causes: BackendDiagnostic['causes'] = [], seen = new Set<unknown>()
  for (let value = error; value && typeof value === 'object' && !seen.has(value) && causes.length < 5;) {
    seen.add(value)
    const item = value as Record<string,unknown>
    causes.push({name:typeof item.name === 'string' && names.has(item.name) ? item.name : 'Error',
      ...(typeof item.code === 'string' && codes.has(item.code) ? {code:item.code} : {}),
      ...(typeof item.status === 'number' && Number.isInteger(item.status) && item.status >= 400 && item.status <= 599 ? {status:item.status} : {})})
    value = item.cause
  }
  return {stage,failure:backendFailure(error),causes}
}
/** Revalidate metadata at the worker boundary; no wire strings reach activity verbatim. */
export function readBackendDiagnostic(value: unknown, fallback: BackendStage): BackendDiagnostic {
  const item = value && typeof value === 'object' ? value as Record<string,unknown> : {}
  const raw = Array.isArray(item.causes) ? item.causes.slice(0,5) : []
  return {stage:stages.has(item.stage as BackendStage) ? item.stage as BackendStage : fallback,
    failure:typeof item.failure === 'string' && Object.hasOwn(failureText,item.failure) ? item.failure as BackendFailure : 'unknown',
    causes:raw.map(cause => backendDiagnostic(cause,fallback).causes[0] ?? {name:'Error'})}
}
export class BackendOperationError extends Error {
  readonly diagnostic: BackendDiagnostic
  constructor(diagnostic: BackendDiagnostic) {
    const safe = readBackendDiagnostic(diagnostic,'initialize')
    super(failureText[safe.failure]); this.name = 'BackendOperationError'; this.diagnostic = safe
  }
}
export function diagnosticText(value: BackendDiagnostic): string {
  const d = readBackendDiagnostic(value,'initialize')
  return `stage=${d.stage}; failure=${d.failure}; causes=${d.causes.map(c=>c.name+(c.code ? `[${c.code}]` : '')+(c.status ? `[HTTP ${c.status}]` : '')).join(' -> ') || 'unavailable'}`
}

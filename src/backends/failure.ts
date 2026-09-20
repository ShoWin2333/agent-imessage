import type { BackendFailure } from './types.js'

/** Read only bounded error metadata. Never expose upstream messages or causes. */
export function backendFailure(error: unknown): BackendFailure {
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
  if (/invalid api key|unauthenticated|unauthorized|authentication failed/i.test(message)) return 'authentication'
  if (/deadline.exceeded|timed? ?out|timeout/i.test(message)) return 'timeout'
  if (/rate.limit|too many requests|resource.exhausted/i.test(message)) return 'rate-limit'
  if (/aborted|aborterror|\bcancell?ed\b/i.test(message)) return 'aborted'
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network error/i.test(message)) return 'network'
  return 'unknown'
}
export const failureText: Record<BackendFailure, string> = {
  'session-busy': '会话已有任务占用。可发送 /new 新建会话，或在本机处理原任务。',
  authentication: '认证失败，请检查对应 Agent 的登录或 API Key。',
  timeout: '后端报告请求超时。任务可能已执行部分操作，请检查后再决定是否重试。',
  aborted: '后端报告请求被中止；目前无法确定是网络、服务端还是 SDK 内部取消。任务未自动重试。',
  network: '后端报告连接错误。任务可能已执行部分操作，请检查后再决定是否重试。',
  'rate-limit': '后端报告限流，请稍后再试。',
  unknown: '后端未提供可识别的失败原因，请查看本机活动记录。',
}

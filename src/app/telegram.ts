import { PluginError } from '../errors.js'
import { TelegramApi, TelegramError } from '../channels/telegram-api.js'
import { record } from '../channels/weixin-api.js'
import { routeChannels } from '../gateway/config.js'
import { validateConfig, type AppConfig, type Secrets } from './config.js'

export function telegramAccounts(config: AppConfig, secrets: Secrets) {
  return Object.keys(secrets.telegram ?? {}).map(botId => {
    const route = config.routes.find(r=>routeChannels(r).some(c=>c.kind==='telegram' && c.botId===botId))
    const channel = route && routeChannels(route).find(c=>c.kind==='telegram' && c.botId===botId)
    const account = secrets.telegramAccounts?.[botId]
    return {botId, username:account?.username ?? '', ownerUserId:account?.ownerUserId ?? (channel?.kind==='telegram' ? channel.ownerUserId : ''), routeId:route?.id ?? '', channelId:channel?.id ?? ''}
  })
}
export async function updateTelegram(config: AppConfig, secrets: Secrets, input: Record<string,unknown>, api = new TelegramApi()) {
  let botId = String(input.botId ?? '')
  const nextSecrets: Secrets = {...secrets,telegram:{...secrets.telegram},telegramAccounts:{...secrets.telegramAccounts}}
  const fail = (message: string): never => {throw new PluginError('invalid-command',message)}
  {
    if ('routeId' in input) fail('请在 Agent 的消息入口中管理绑定。')
    const token = typeof input.token==='string' ? input.token.trim() : ''
    const ownerUserId = String(input.ownerUserId ?? '').trim()
    if (!/^[1-9]\d{0,15}$/.test(ownerUserId) || !Number.isSafeInteger(Number(ownerUserId))) fail('请填写你本人的纯数字 Telegram 用户 ID；不能填写 @用户名、手机号或 Bot ID。')
    let username = nextSecrets.telegramAccounts?.[botId]?.username ?? ''
    if (token) {
      if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token)) fail('Bot Token 格式无效。')
      let me: Record<string,unknown>
      try { me=record(await api.request(token,'getMe',{},AbortSignal.timeout(10_000))) }
      catch (error) {
        if (error instanceof TelegramError && [401,404].includes(error.code)) return fail('Bot Token 无效或已撤销，请从 @BotFather 重新复制。')
        if (error instanceof TelegramError && error.code===429) return fail('Telegram 请求过于频繁，请稍后重试。')
        return fail('无法连接 Telegram 或验证超时，请检查本机网络能否访问 api.telegram.org，然后重试。')
      }
      if (me.is_bot!==true || !Number.isSafeInteger(me.id) || String(me.id)!==token.split(':')[0]) fail('Telegram Bot 身份验证失败。')
      if (botId && botId!==String(me.id)) fail('此 Token 属于另一个 Bot，请使用添加 Bot。')
      botId=String(me.id); username=typeof me.username==='string' ? me.username : ''
      nextSecrets.telegram![botId]=token
    }
    if (!nextSecrets.telegram?.[botId]) fail('请先提供 Bot Token。')
    nextSecrets.telegramAccounts![botId]={ownerUserId,username}
  }
  const account=telegramAccounts(config,nextSecrets).find(a=>a.botId===botId)
  if (!account?.ownerUserId) return fail('请先在消息渠道添加 Bot 并配置允许操作的用户。')
  nextSecrets.telegramAccounts![botId]={ownerUserId:account.ownerUserId,username:account.username}
  const routes=config.routes.map(route=>({
    ...route,
    ...(route.channels ? {channels:route.channels.map(channel=>channel.kind==='telegram' && channel.botId===botId ? {...channel,ownerUserId:account.ownerUserId} : channel)} : {}),
  }))
  return {config:await validateConfig({...config,routes},false),secrets:nextSecrets,botId}
}

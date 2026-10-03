import { REST, Routes } from 'discord.js'
import { PluginError } from '../errors.js'
import { routeChannels, discordId } from '../gateway/config.js'
import { validateConfig, type AppConfig, type Secrets } from './config.js'
import { object } from '../backends/jsonrpc.js'

/** Public account metadata only; tokens never leave the private secrets file. */
export function discordAccounts(config: AppConfig, secrets: Secrets) {
  return Object.keys(secrets.discord ?? {}).map(botId => {
    const route = config.routes.find(r => routeChannels(r).some(c => c.kind === 'discord' && c.botId === botId))
    const channel = route && routeChannels(route).find(c => c.kind === 'discord' && c.botId === botId)
    const account = secrets.discordAccounts?.[botId]
    return {botId,username:account?.username ?? '',ownerUserId:account?.ownerUserId ?? (channel?.kind === 'discord' ? channel.ownerUserId : ''),routeId:route?.id ?? '',channelId:channel?.id ?? ''}
  })
}
export async function verifyDiscordBot(token: string): Promise<Record<string,unknown>> {
  return object(await new REST({version:'10',timeout:10_000,retries:0}).setToken(token).get(Routes.user('@me'),{signal:AbortSignal.timeout(10_000)}))
}
export async function updateDiscord(config: AppConfig, secrets: Secrets, input: Record<string,unknown>, verify = verifyDiscordBot) {
  const fail = (message: string): never => {throw new PluginError('invalid-command',message)}
  if ('routeId' in input) fail('Manage Discord bindings in the Agent channel settings.')
  const ownerUserId = typeof input.ownerUserId === 'string' ? input.ownerUserId.trim() : ''
  if (!discordId.safeParse(ownerUserId).success) fail('Enter your own numeric Discord user ID, copied with Developer Mode.')
  if (input.botId !== undefined && typeof input.botId !== 'string') fail('Discord bot IDs must be strings.')
  let botId = typeof input.botId === 'string' ? input.botId.trim() : ''
  if (botId && !discordId.safeParse(botId).success) fail('Invalid Discord bot ID.')
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  const next: Secrets = {...secrets,discord:{...secrets.discord},discordAccounts:{...secrets.discordAccounts}}
  let username = next.discordAccounts?.[botId]?.username ?? ''
  if (token) {
    if (token.length > 512 || /\s/.test(token)) fail('Invalid Discord bot token format.')
    let me: Record<string,unknown>
    try {me = await verify(token)}
    catch {return fail('Could not verify the Discord bot. Check its token and network access, then retry.')}
    if (me.bot !== true || !discordId.safeParse(me.id).success) fail('Discord credentials must belong to a bot.')
    if (botId && botId !== me.id) fail('This token belongs to a different bot. Add it as a new bot.')
    botId = String(me.id); username = typeof me.username === 'string' ? me.username : ''
    next.discord![botId] = token
  }
  if (!Object.hasOwn(next.discord ?? {},botId) || !next.discord?.[botId]) fail('Provide a Discord bot token in the local app.')
  if (ownerUserId === botId) fail('The allowed owner must be your user ID, not the bot ID.')
  next.discordAccounts![botId] = {ownerUserId,username}
  const routes = config.routes.map(r => ({...r,...(r.channels ? {channels:r.channels.map(c => c.kind === 'discord' && c.botId === botId ? {...c,ownerUserId} : c)} : {})}))
  return {config:await validateConfig({...config,routes},false),secrets:next,botId}
}

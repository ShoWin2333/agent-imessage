import { Client, ChannelType, Events, GatewayIntentBits, Partials, PermissionFlagsBits, Routes, MessageType, type Message, type ClientOptions } from 'discord.js'
import type { ChannelConfig } from '../gateway/config.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import type { RuntimeView } from '../types.js'
import { pause } from './weixin-api.js'

export type DiscordScope = Extract<ChannelConfig, {kind: 'discord'}>
export type DiscordClientFactory = (options: ClientOptions) => Client
const noMentions = {parse: [], replied_user: false}
class DiscordBindingError extends Error {}

/** Discord counts UTF-16 code units. Never split a surrogate pair or grapheme. */
export function splitDiscordText(text: string): string[] {
  const parts: string[] = []
  let part = ''
  for (const {segment} of new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(text)) {
    if (segment.length > 2000) throw new Error('Discord text contains an oversized segment')
    if (part.length + segment.length > 2000) { parts.push(part); part = '' }
    part += segment
  }
  if (part) parts.push(part)
  return parts
}

/** One bot/owner binding. discord.js owns heartbeats, session resume and REST limits. */
export class DiscordAdapter implements ChannelAdapter {
  state: RuntimeView = {phase:'stopped'}
  private controller: AbortController | undefined
  private client: Client | undefined
  private destination: string | undefined
  private task: Promise<void> | undefined
  private stopping: Promise<void> | undefined

  constructor(private readonly scope: DiscordScope, private readonly token: string,
    private readonly onMessage: (message: ChannelMessage) => Promise<void>,
    private readonly onState: (state: RuntimeView) => void,
    private readonly createClient: DiscordClientFactory = options => new Client(options)) {}

  private publish(state: RuntimeView) { this.state = state; this.onState(state) }
  async start(): Promise<void> {
    await this.stopping
    if (this.controller) return
    const controller = this.controller = new AbortController()
    this.publish({phase:'starting'})
    this.task = this.connect(controller.signal).catch(() => {
      if (!controller.signal.aborted) this.fail('Discord connection failed. Check bot credentials and channel access, then retry.')
    })
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.controller?.abort(); this.controller = undefined; this.destination = undefined
    const client = this.client; this.client = undefined
    this.publish({phase:'stopped'})
    this.stopping = Promise.all([client?.destroy().catch(() => {}), this.task]).then(() => {}).finally(() => {this.stopping = undefined})
    return this.stopping
  }
  private fail(message: string) {
    this.destination = undefined
    this.publish({phase:'failed',error:{code:'runtime-failed',message}})
  }
  async scheduledMessage(id: string, text: string): Promise<ChannelMessage> {
    const signal = this.controller?.signal, client = this.client, destination = this.destination
    if (!signal || signal.aborted || !client?.isReady() || !destination || this.state.phase !== 'listening') throw new Error('Discord is not connected')
    return this.message(id, text, client, destination, signal)
  }
  private message(id: string, text: string, client: Client, destination: string, signal: AbortSignal): ChannelMessage {
    const ready = () => {
      signal.throwIfAborted()
      if (client !== this.client || !client.isReady() || destination !== this.destination || this.state.phase !== 'listening') throw new Error('Discord connection changed')
    }
    const post = async (body: object) => {
      ready()
      try { await client.rest.post(Routes.channelMessages(destination), {body,signal}) }
      catch { throw new Error('Discord message delivery failed. Check channel permissions and attachment limits.') }
    }
    return {id,text,nativeVoice:false,
      send: async value => {for (const part of splitDiscordText(value)) await post({content:part,allowed_mentions:noMentions})},
      sendFile: async media => {
        ready()
        // Conservative default: Discord may impose a smaller account/server limit.
        if (media.bytes.byteLength > 10 * 1024 * 1024) throw new Error('Discord attachments must be at most 10 MiB')
        try {
          await client.rest.post(Routes.channelMessages(destination), {body:{allowed_mentions:noMentions},
            files:[{data:media.bytes,name:media.name,contentType:media.mimeType}],signal})
        } catch { throw new Error('Discord attachment delivery failed. Check channel permissions and upload limits.') }
      },
      sendVoice: async () => {throw new Error('Use file delivery for Discord audio')},
      responding: async callback => {
        const typing = new AbortController(), combined = AbortSignal.any([signal,typing.signal])
        const work = (async () => {
          while (!combined.aborted) {
            ready()
            await client.rest.post(Routes.channelTyping(destination), {signal:combined}).catch(() => {})
            await pause(combined,8000)
          }
        })().catch(() => {})
        // A REST rate-limit queue may outlive cancellation; its rejection is handled
        // above, and the combined signal fences the eventual request.
        void work
        try { return await callback() } finally {typing.abort()}
      },
    }
  }
  private accepted(raw: Message, client: Client): string | undefined {
    if (raw.author.bot || raw.author.id !== this.scope.ownerUserId || raw.webhookId || raw.system ||
      ![MessageType.Default,MessageType.Reply].includes(raw.type) || raw.channelId !== this.destination) return
    if (this.scope.guildId) {
      if (raw.guildId !== this.scope.guildId || raw.channelId !== this.scope.channelId) return
      const mention = new RegExp(`<@!?${this.scope.botId}>`, 'g')
      // Explicit mention also admits content without privileged MessageContent intent.
      if (!mention.test(raw.content)) return
      return raw.content.replace(mention,'').trim()
    }
    if (raw.guildId !== null || raw.channel.type !== ChannelType.DM || client.user?.id !== this.scope.botId) return
    return raw.content.trim()
  }
  private async connect(signal: AbortSignal): Promise<void> {
    let attempt = 0
    while (!signal.aborted) {
      const client = this.client = this.createClient({
        intents:this.scope.guildId ? [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages] : [GatewayIntentBits.DirectMessages],
        partials:[Partials.Channel], allowedMentions:{parse:[],repliedUser:false},
        rest:{timeout:15_000,retries:2},
      })
      let validated = false, terminal = false, queued = 0
      let queue = Promise.resolve()
      const current = () => !terminal && !signal.aborted && this.client === client
      const listening = () => {if (current() && validated) this.publish({phase:'listening',connectedAt:Date.now()})}
      client.on(Events.ShardReady, listening)
      client.on(Events.ShardResume, listening)
      client.on(Events.ShardReconnecting, () => {
        if (current() && validated) this.publish({phase:'retrying',attempt:1,retryAt:Date.now()+5000})
      })
      client.on(Events.ShardDisconnect, event => {
        if (!current() || !validated) return
        if ([4004,4013,4014].includes(event.code)) {
          terminal = true
          this.fail('Discord authorization or Gateway intents were rejected. Check the bot setup, then retry.')
          void client.destroy().catch(() => {})
        } else this.publish({phase:'retrying',attempt:1,retryAt:Date.now()+5000})
      })
      client.on(Events.Invalidated, () => {
        if (!current()) return
        terminal = true
        this.fail('Discord session was invalidated. Retry this channel.')
        void client.destroy().catch(() => {})
      })
      // discord.js error events must always have listeners; never publish raw errors/tokens.
      client.on(Events.Error, () => {})
      client.on(Events.ShardError, () => {})
      client.on(Events.MessageCreate, raw => {
        if (!current() || !validated || this.state.phase !== 'listening') return
        const text = this.accepted(raw,client)
        if (!text || queued >= 32) return
        const message = this.message(`discord:${raw.channelId}:${raw.id}`,text,client,this.destination!,signal)
        queued++
        queue = queue.then(async () => {
          if (current() && this.state.phase === 'listening') await this.onMessage(message)
        }).catch(() => {}).finally(() => {queued--})
      })
      const timeout = AbortSignal.timeout(30_000), combined = AbortSignal.any([signal,timeout])
      let onAbort!: () => void
      const aborted = new Promise<never>((_,reject) => {
        onAbort = () => reject(new Error('Discord connection cancelled or timed out'))
        combined.addEventListener('abort',onAbort,{once:true})
      })
      try {
        const open = async () => {
          await client.login(this.token)
          combined.throwIfAborted()
          if (client.user?.id !== this.scope.botId || !client.user.bot) throw new DiscordBindingError('Bot identity mismatch')
          const target = this.scope.guildId ? await client.channels.fetch(this.scope.channelId!) : await client.users.createDM(this.scope.ownerUserId)
          combined.throwIfAborted()
          if (!target || (this.scope.guildId
            ? target.type !== ChannelType.GuildText || target.guildId !== this.scope.guildId || !target.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.AttachFiles])
            : target.type !== ChannelType.DM || target.recipientId !== this.scope.ownerUserId)) throw new DiscordBindingError('Channel binding or permissions mismatch')
          if (!current()) return
          this.destination = target.id; validated = true; listening()
        }
        await Promise.race([open(),aborted])
        return // discord.js now maintains this connection until stop or fatal failure.
      } catch (error) {
        if (this.client === client) {this.client = undefined; this.destination = undefined}
        await client.destroy().catch(() => {})
        if (signal.aborted) return
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        if (error instanceof DiscordBindingError || ['TokenInvalid','DisallowedIntents','InvalidIntents','4004','4013','4014','401','403','50001','50013','10003'].includes(code)) {
          this.fail('Discord bot identity, authorization or channel permissions are invalid. Check setup, then retry.')
          return
        }
        const delay = Math.min(60_000,1000 * 2 ** Math.min(attempt++,6))
        this.publish({phase:'retrying',attempt,retryAt:Date.now()+delay})
        await pause(signal,delay)
      } finally {combined.removeEventListener('abort',onAbort)}
    }
  }
}

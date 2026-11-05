import type { RouteState } from '../channels/state.js'
import type { RuntimeView, TelegramRetryReason } from '../types.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import { TelegramApi, TelegramError, supportsTelegramVoice } from './telegram-api.js'
import { pause, record } from './weixin-api.js'
import { approvalStatus, APPROVAL_STATUS_RESERVE } from './approval.js'

export function splitTelegramText(text: string, limit = 4096): string[] {
  const result: string[] = []; let part = ''
  for (const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)) {
    if (segment.length > limit) throw new Error('Oversized text segment')
    if (part.length + segment.length > limit) { result.push(part); part = '' }
    part += segment
  }
  if (part) result.push(part)
  return result
}
const approvalCallback = /^dsh:(approve|deny):(a-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/

export interface TelegramCredential { token: string; botId: string; ownerUserId: string }

/** One long-poll consumer per bot, accepting only the configured owner's private DM. */
export class TelegramAdapter implements ChannelAdapter {
  state: RuntimeView = {phase:'stopped'}
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  constructor(private readonly credential: TelegramCredential,
    private readonly store: {state: RouteState; save(): Promise<void>},
    private readonly onMessage: (message: ChannelMessage) => Promise<void>,
    private readonly onState: (state: RuntimeView) => void,
    private readonly api = new TelegramApi()) {}
  private publish(state: RuntimeView) { this.state = state; this.onState(state) }
  async start() {
    await this.stopping
    if (this.controller) return
    this.controller = new AbortController()
    this.publish({phase:'starting'})
    this.task = this.run(this.controller.signal).catch(()=>{
      if (this.controller && !this.controller.signal.aborted) this.publish({phase:'failed',error:{code:'runtime-failed',message:'Telegram 连接停止，请重试。'}})
    })
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.controller?.abort(); this.controller = undefined
    this.publish({phase:'stopped'})
    this.stopping = Promise.resolve(this.task).finally(()=>{this.stopping=undefined})
    return this.stopping
  }
  approvalMessage() { return this.scheduledMessage('approval', '') }
  async scheduledMessage(id: string, text: string): Promise<ChannelMessage> {
    const signal = this.controller?.signal
    if (!signal || signal.aborted || this.state.phase !== 'listening') throw new Error('Telegram is not connected')
    return this.message(id,text,signal)
  }
  private message(id: string, text: string, signal: AbortSignal): ChannelMessage {
    const {token,ownerUserId} = this.credential
    return {id,text,nativeVoice:true,supportsNativeVoice:supportsTelegramVoice,
      send: async value => {
        for (const part of splitTelegramText(value)) await this.api.request(token,'sendMessage',{chat_id:ownerUserId,text:part},signal)
      },
      sendApproval: async (value, approvalToken, cancellation) => {
        const combined = AbortSignal.any([signal, cancellation])
        const parts = splitTelegramText(value, 4096 - APPROVAL_STATUS_RESERVE)
        const last = parts.pop()
        if (!last) throw new Error('Telegram approval prompt is empty')
        for (const part of parts) {
          await this.api.request(token, 'sendMessage', { chat_id: ownerUserId, text: part }, combined)
        }
        const sent = record(await this.api.request(token, 'sendMessage', {
          chat_id: ownerUserId,
          text: last,
          reply_markup: { inline_keyboard: [[
            { text: '批准一次', callback_data: `dsh:approve:${approvalToken}` },
            { text: '拒绝', callback_data: `dsh:deny:${approvalToken}` },
          ]] },
        }, combined))
        const messageId = sent.message_id
        if (!Number.isSafeInteger(messageId)) return
        return async outcome => {
          const status = approvalStatus(outcome)
          await this.api.request(token, 'editMessageText', {
            chat_id: ownerUserId, message_id: messageId, text: `${last}\n\n${status}`,
            reply_markup: { inline_keyboard: [] },
          }, AbortSignal.any([signal, AbortSignal.timeout(3000)]))
        }
      },
      sendImage: (media, cancellation) => this.api.photo(token,ownerUserId,media,cancellation ? AbortSignal.any([signal,cancellation]) : signal),
      sendFile: (media, cancellation) => this.api.file(token,ownerUserId,media,cancellation ? AbortSignal.any([signal,cancellation]) : signal),
      sendVoice: (media, cancellation) => this.api.voice(token,ownerUserId,media,cancellation ? AbortSignal.any([signal,cancellation]) : signal),
      responding: async callback => {
        const typing = new AbortController(), combined = AbortSignal.any([signal,typing.signal])
        const work = (async()=>{
          while (!combined.aborted) {
            await this.api.request(token,'sendChatAction',{chat_id:ownerUserId,action:'typing'},combined).catch(()=>{})
            await pause(combined,4000)
          }
        })().catch(()=>{})
        try { return await callback() } finally { typing.abort(); await work }
      },
    }
  }
  private async admit(message: ChannelMessage, signal: AbortSignal) {
    // Handler admission may wait for a backend. Stop polling promptly on abort.
    signal.throwIfAborted()
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try { await Promise.race([this.onMessage(message), aborted]) }
    finally { signal.removeEventListener('abort', onAbort) }
  }
  private async handleApprovalCallback(raw: unknown, signal: AbortSignal) {
    const { token, botId, ownerUserId } = this.credential
    const query = record(raw), sender = record(query.from), prompt = record(query.message)
    const chat = record(prompt.chat), author = record(prompt.from)
    if (sender.is_bot !== false || String(sender.id) !== ownerUserId || chat.type !== 'private'
      || String(chat.id) !== ownerUserId || author.is_bot !== true || String(author.id) !== botId
      || typeof query.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(query.id)) return

    const match = typeof query.data === 'string' ? approvalCallback.exec(query.data) : null
    // Acknowledge transport receipt immediately. This grants nothing: the bridge
    // still persists admission before recording the actual approval decision.
    const acknowledgement = this.api.request(token, 'answerCallbackQuery', { callback_query_id: query.id },
      AbortSignal.any([signal, AbortSignal.timeout(3000)])).catch(() => {})
    if (match) {
      const message = this.message(`telegram-callback:${query.id}`, `/${match[1]} ${match[2]}`, signal)
      await this.admit(message, signal)
    }
    await acknowledgement
  }
  private async run(signal: AbortSignal) {
    let verified = false, failures = 0
    while (!signal.aborted) {
      let retryReason: TelegramRetryReason = 'telegram-verify'
      try {
        if (!verified) {
          const me = record(await this.api.request(this.credential.token,'getMe',{},signal))
          if (String(me.id) !== this.credential.botId || me.is_bot !== true) throw new TelegramError(401)
          verified = true
        }
        retryReason = 'telegram-poll'
        const batch = await this.api.request(this.credential.token,'getUpdates',{
          offset:Number(this.store.state.channelCursor ?? 0),timeout:25,allowed_updates:['message', 'callback_query'],
        },signal)
        signal.throwIfAborted()
        if (!Array.isArray(batch)) throw new TelegramError(0)
        failures = 0
        if (this.state.phase !== 'listening') this.publish({phase:'listening',connectedAt:Date.now()})
        for (const item of batch) {
          signal.throwIfAborted()
          retryReason = 'telegram-poll'
          const update = record(item)
          if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) throw new TelegramError(0)
          const raw = record(update.message), from = record(raw.from), chat = record(raw.chat)
          if (update.callback_query !== undefined) {
            retryReason = 'telegram-admission'
            await this.handleApprovalCallback(update.callback_query, signal)
          } else if (chat.type === 'private' && from.is_bot === false && String(from.id) === this.credential.ownerUserId && String(chat.id) === this.credential.ownerUserId && Number.isSafeInteger(raw.message_id)) {
            retryReason = 'telegram-admission'
            const id = `telegram:${raw.message_id}`
            if (typeof raw.text === 'string' && raw.text.trim()) {
              await this.admit(this.message(id, raw.text, signal), signal)
            } else if (['photo','voice','audio','document','video','sticker','animation','video_note'].some(key=>key in raw) && !this.store.state.seen.includes(id)) {
              await this.message(id,'',signal).send('目前支持文字任务和文件回传；请将图片、语音或文件中的任务改为文字发送。')
              this.store.state.seen.push(id); this.store.state.seen = this.store.state.seen.slice(-1024)
            }
          }
          retryReason = 'telegram-checkpoint'
          this.store.state.channelCursor = String(Number(update.update_id)+1)
          await this.store.save()
        }
        await pause(signal,250)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof TelegramError && [401,403,409].includes(error.code)) {
          this.publish({phase:'failed',error:{code:'runtime-failed',message:error.code === 409 ? 'Telegram 存在其他轮询或 Webhook，请关闭冲突连接后重试。' : 'Telegram 授权失败，请检查 Bot Token 与账号。'}})
          return
        }
        const wait = Math.max(error instanceof TelegramError ? error.retryAfter : 0,Math.min(60_000,1000 * 2 ** Math.min(failures++,6)))
        this.publish({phase:'retrying',attempt:failures,retryAt:Date.now()+wait,retryReason})
        await pause(signal,wait)
      }
    }
  }
}

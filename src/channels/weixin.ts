import type { WeixinCredential } from '../app/config.js'
import type { RouteState } from '../gateway/state.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import type { RuntimeView } from '../types.js'
import { WeixinApi, WeixinError, pause, record, string } from './weixin-api.js'

/** Match iLink's UTF-16 length bound without splitting emoji or combining sequences. */
export function splitWeixinText(text: string): string[] {
  const parts: string[] = []; let current = ''
  for (const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)) {
    if (segment.length > 1800) throw new Error('Message contains an oversized text segment')
    if (current.length + segment.length > 1800) { parts.push(current); current='' }
    current += segment
  }
  if (current) parts.push(current)
  return parts
}

/** One bound owner, one DM, one isolated router; tokens never leave this adapter. */
export class WeixinAdapter implements ChannelAdapter {
  state: RuntimeView = {phase:'stopped'}
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  constructor(private readonly credential: WeixinCredential,
    private readonly store: {state: RouteState; save(): Promise<void>},
    private readonly onMessage: (message: ChannelMessage) => Promise<void>,
    private readonly onState: (state: RuntimeView) => void,
    private readonly api = new WeixinApi()) {}
  private publish(state: RuntimeView) { this.state = state; this.onState(state) }
  async start() {
    await this.stopping
    if (this.controller) return
    this.controller = new AbortController()
    this.publish({phase:'starting'})
    this.task = this.run(this.controller.signal).catch(() => {
      if (this.controller && !this.controller.signal.aborted) this.publish({phase:'failed',error:{code:'runtime-failed',message:'微信连接停止，请重试。'}})
    })
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const controller = this.controller
    this.controller = undefined
    controller?.abort()
    this.publish({phase:'stopped'})
    const work = (async()=>{
      await this.task
      if (controller) await this.api.notify(this.credential,'stop',AbortSignal.timeout(5000)).catch(()=>{})
    })()
    this.stopping = work.finally(()=>{this.stopping=undefined})
    return this.stopping
  }
  async scheduledMessage(id: string, text: string): Promise<ChannelMessage> {
    const context = this.store.state.weixinContext, signal = this.controller?.signal
    if (!context || !signal || signal.aborted || this.state.phase !== 'listening') throw new Error('WeChat needs an active conversation')
    return this.message(id,text,context,signal)
  }
  private message(id: string, text: string, context: string, signal: AbortSignal): ChannelMessage {
    const user = this.credential.ownerUserId
    return { id, text, nativeVoice:false,
            send: async value => { for (const part of splitWeixinText(value)) await this.api.send(this.credential,user,context,part,signal) },
            sendFile: media => this.api.file(this.credential,user,context,media,signal),
            sendVoice: async () => { throw new Error('Native voice is not supported by this channel; use file delivery') },
            responding: async callback => {
              const typing = new AbortController(), combined = AbortSignal.any([signal,typing.signal])
              const task = (async () => { while (!combined.aborted) { await this.api.typing(this.credential,user,context,combined).catch(() => {}); await pause(combined,10_000) } })().catch(() => {})
              try { return await callback() } finally { typing.abort(); await task }
            },
          }
  }
  private async run(signal: AbortSignal) {
    let failures = 0, announced = false
    while (!signal.aborted) {
      try {
        if (!announced) { await this.api.notify(this.credential,'start',signal); announced=true }
        const batch = await this.api.updates(this.credential,this.store.state.channelCursor ?? '',signal)
        if (signal.aborted) return
        failures = 0
        if (this.state.phase !== 'listening') this.publish({phase:'listening',connectedAt:Date.now()})
        for (const value of Array.isArray(batch.msgs) ? batch.msgs : []) {
          if (signal.aborted) return
          const raw = record(value), user = string(raw.from_user_id), context = string(raw.context_token)
          if (user !== this.credential.ownerUserId || raw.message_type !== 1 || !context) continue
          if (raw.to_user_id && raw.to_user_id !== this.credential.accountId) continue
          const id = typeof raw.message_id === 'string' ? raw.message_id : Number.isSafeInteger(raw.message_id) ? String(raw.message_id) : ''
          if (!id) continue
          const items = Array.isArray(raw.item_list) ? raw.item_list.map(record) : []
          const text = items.filter(i => i.type === 1).map(i => string(record(i.text_item).text)).join('\n')
          // Do not silently execute partial prompts when unsupported attachments are present.
          if (items.some(i => i.type !== 1)) {
            if (!this.store.state.seen.includes(id)) {
              this.store.state.seen.push(id); this.store.state.seen = this.store.state.seen.slice(-1024); await this.store.save()
              await this.api.send(this.credential,user,context,'目前支持文字任务和文件回传；请将图片、语音或文件中的任务改为文字发送。',signal)
            }
            continue
          }
          if (!text) continue
          this.store.state.weixinContext = context
          await this.store.save()
          const message = this.message(id,text,context,signal)
          // Stop must not wait for an Agent's session creation or turn admission.
          // Gateway closes the backend next; the handler promise remains observed.
          signal.throwIfAborted()
          let onAbort!: () => void
          const aborted = new Promise<never>((_,reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort',onAbort,{once:true}) })
          try { await Promise.race([this.onMessage(message),aborted]) }
          finally { signal.removeEventListener('abort',onAbort) }
        }
        if (typeof batch.get_updates_buf === 'string') { this.store.state.channelCursor = batch.get_updates_buf; await this.store.save() }
        await pause(signal,250)
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof WeixinError && error.code === 'auth') {
          this.publish({phase:'failed',error:{code:'runtime-failed',message:'微信凭据已失效，请重新扫码绑定。'}}); return
        }
        const wait = Math.min(60_000,1000 * 2 ** Math.min(failures++,6))
        this.publish({phase:'retrying',attempt:failures,retryAt:Date.now()+wait})
        await pause(signal,wait)
      }
    }
  }
}

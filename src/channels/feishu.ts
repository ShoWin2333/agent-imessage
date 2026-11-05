import type { ChannelConfig } from './config.js'
import type { ChannelAdapter, ChannelMessage } from './types.js'
import type { RouteState } from './state.js'
import type { RuntimeView } from '../types.js'
import type { OutboundMediaPayload } from '../media.js'
import { createFeishuClient, type FeishuClientFactory, type FeishuConnection, type FeishuEvent } from './feishu-api.js'
import { approvalStatus } from './approval.js'

export type FeishuScope = Extract<ChannelConfig, {kind:'feishu'}>
/** Conservative UTF-8 budget leaves room inside Feishu's 150 KB message envelope. */
export function splitFeishuText(text: string, limit = 12_000): string[] {
  const parts: string[] = []; let part = '', size = 0
  for (const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)) {
    const bytes = Buffer.byteLength(segment)
    if (bytes > limit) throw new Error('Feishu text contains an oversized segment')
    if (size + bytes > limit) {parts.push(part); part = ''; size = 0}
    part += segment; size += bytes
  }
  if (part) parts.push(part)
  return parts
}

/** One app, tenant, owner and private chat. Group/bot/media ingress stays closed. */
export class FeishuAdapter implements ChannelAdapter {
  state: RuntimeView = {phase:'stopped'}
  private controller: AbortController | undefined
  private client: FeishuConnection | undefined
  private watchdog: ReturnType<typeof setTimeout> | undefined
  private stopping: Promise<void> | undefined
  private checkpoint = Promise.resolve()
  private readonly pending = new Map<string, {work:Promise<void>; control:boolean}>()
  constructor(private readonly scope: FeishuScope, private readonly secret: string,
    private readonly store: {state:RouteState; save():Promise<void>},
    private readonly onMessage: (message:ChannelMessage) => Promise<void>,
    private readonly onState: (state:RuntimeView) => void,
    private readonly createClient: FeishuClientFactory = createFeishuClient) {}
  private publish(state: RuntimeView) {this.state = state; this.onState(state)}
  private clearWatchdog() {if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = undefined}
  private fail(signal: AbortSignal) {
    if (signal !== this.controller?.signal || signal.aborted) return
    this.clearWatchdog(); this.controller?.abort(); this.client?.close()
    this.publish({phase:'failed',error:{code:'runtime-failed',message:'Feishu connection failed. Check self-built app credentials, event subscription and access, then retry.'}})
  }
  async start(): Promise<void> {
    await this.stopping
    if (this.controller) return
    const signal = (this.controller = new AbortController()).signal
    this.pending.clear()
    this.publish({phase:'starting'})
    // ws.start resolves before the handshake. Publish listening only from onReady.
    const current = () => signal === this.controller?.signal && !signal.aborted
    const ready = () => {if (current()) {this.clearWatchdog(); this.publish({phase:'listening',connectedAt:Date.now()})}}
    try {
      this.client = this.createClient(this.scope.appId,this.secret,this.scope.ownerUserId,signal,{
        ready,
        reconnecting:() => {if (current()) this.publish({phase:'retrying',attempt:1,retryAt:Date.now()+5000})},
        failed:() => this.fail(signal),
        message:event => this.receive(event,signal),
      })
      this.watchdog = setTimeout(() => this.fail(signal),60_000)
      await this.client.start()
    } catch {this.fail(signal)}
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.clearWatchdog(); this.controller?.abort(); this.controller = undefined
    const client = this.client; this.client = undefined
    this.pending.clear(); this.publish({phase:'stopped'})
    this.stopping = Promise.resolve().then(() => client?.close()).finally(() => {this.stopping = undefined})
    return this.stopping
  }
  approvalMessage() {return this.scheduledMessage('approval','')}
  async scheduledMessage(id: string, text: string): Promise<ChannelMessage> {
    const signal = this.controller?.signal, client = this.client
    if (!signal || signal.aborted || !client || this.state.phase !== 'listening') throw new Error('Feishu is not connected')
    return this.message(id,text,client,signal)
  }
  private message(id: string, text: string, client: FeishuConnection, signal: AbortSignal): ChannelMessage {
    const ready = () => {
      signal.throwIfAborted()
      if (this.client !== client || this.state.phase !== 'listening') throw new Error('Feishu connection changed')
    }
    const send = async (value: string, cancellation?: AbortSignal) => {
      const combined = AbortSignal.any([signal,cancellation ?? signal])
      for (const part of splitFeishuText(value)) {ready(); combined.throwIfAborted(); await client.send(part,combined)}
    }
    const upload = async (media: OutboundMediaPayload, cancellation?: AbortSignal, image = false) => {
      ready()
      const combined = AbortSignal.any([signal,cancellation ?? signal]); combined.throwIfAborted()
      if (media.bytes.byteLength > (image ? 10 : 20) * 1024 * 1024) throw new Error('Feishu attachment exceeds the channel size limit')
      await client.upload(media,image,combined)
    }
    return {id,text,nativeVoice:false,responding:callback => callback(),send,
      sendApproval: async (value,token,cancellation) => {
        if (!/^a-[0-9a-f-]{36}$/.test(token)) throw new Error('Invalid approval token')
        await send(`${value}\n\n批准：/approve ${token}\n拒绝：/deny ${token}`,cancellation)
        return outcome => send(`DSH 审批 ${token}：${approvalStatus(outcome)}。`)
      },
      sendImage:(media,cancellation) => upload(media,cancellation,true),sendFile:upload,
      sendVoice:() => Promise.reject(new Error('Feishu voice uses file delivery')),
    }
  }
  private receive(event: FeishuEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted || signal !== this.controller?.signal) return Promise.reject(new Error('Feishu connection changed'))
    const {message, sender} = event
    if (event.app_id !== this.scope.appId || event.tenant_key !== this.scope.tenantKey || sender?.tenant_key !== this.scope.tenantKey
      || sender.sender_type !== 'user' || sender.sender_id?.open_id !== this.scope.ownerUserId
      || message?.chat_type !== 'p2p' || message.chat_id !== this.scope.chatId || message.message_type !== 'text'
      || !/^om_[A-Za-z0-9_-]{1,128}$/.test(message.message_id) || typeof message.content !== 'string' || Buffer.byteLength(message.content) > 64*1024) return Promise.resolve()
    let text: unknown
    try {text = (JSON.parse(message.content) as {text?:unknown} | null)?.text} catch {return Promise.resolve()}
    if (typeof text !== 'string' || !text.trim()) return Promise.resolve()
    const id = `feishu:${this.scope.appId}:${message.chat_id}:${message.message_id}`
    const existing = this.pending.get(id)
    if (existing) return existing.work
    if (this.store.state.seen.includes(id)) return Promise.resolve()
    const acceptedText = text.trim()
    const control = /^\/(cancel|stop|status|help)$/.test(acceptedText) || /^\/(approve|deny|answer)(?:\s|$)/.test(acceptedText)
    // Reserve a separate bounded budget for controls. Bridge owns admission
    // ordering; entering it concurrently lets /cancel fence slow/queued turns.
    const count = [...this.pending.values()].filter(item => item.control === control).length
    if (this.state.phase !== 'listening' || count >= 32) return Promise.reject(new Error('Feishu admission is temporarily unavailable'))
    const work = Promise.resolve().then(async () => {
      if (signal.aborted || signal !== this.controller?.signal || this.state.phase !== 'listening') throw new Error('Feishu connection changed')
      if (this.store.state.seen.includes(id)) return
      await this.onMessage(await this.scheduledMessage(id,acceptedText))
      // Admission owns durability. Serialize only transport checkpoints so
      // concurrent controls cannot lose IDs or roll back another saved update.
      const saved = this.checkpoint.then(async () => {
        if (signal.aborted || signal !== this.controller?.signal) throw new Error('Feishu connection changed')
        const previous = this.store.state.seen
        this.store.state.seen = [...previous,id].slice(-1024)
        try {await this.store.save()} catch {this.store.state.seen = previous; throw new Error('Feishu checkpoint could not be saved')}
      })
      this.checkpoint = saved.catch(() => {})
      await saved
    }).catch(() => {throw new Error('Feishu message admission could not be confirmed')})
    this.pending.set(id,{work,control})
    void work.finally(() => {if (this.pending.get(id)?.work === work) this.pending.delete(id)}).catch(() => {})
    return work
  }
}

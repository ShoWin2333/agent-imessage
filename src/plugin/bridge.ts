import { randomUUID } from 'node:crypto'
import { ChannelInteractions } from './interactions.js'
import { bounded } from './delivery.js'
import type { LegacySessionIdentity } from './identity.js'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalInteraction, InteractionHandlers } from './interaction-types.js'
import type { ChannelMessage } from '../channels/types.js'
import type { MediaHandler, MediaInteraction, MediaDeliveryResult, StoredMediaReceipt } from './media-delivery.js'

export interface NativeResult { text: string; reason: string; suppressed?: boolean | undefined }
export interface NativeSession {
  readonly id: string
  isLive?(): boolean
  submit(id: string, text: string, progress: () => void, interactions?: InteractionHandlers, media?: MediaHandler, stream?: (text:string)=>void, notice?: (text:string)=>Promise<void>): { admitted: Promise<void>; result: Promise<NativeResult> }
  cancel(): void
  close(): Promise<void>
}
export interface NativePreferences {model?:{provider:string;model:string}|undefined;preset?:string|undefined}
export interface NativeHost {
  configure?(preferences:NativePreferences):void
  command?(text:string,sessionId:string|undefined,preferences:NativePreferences):Promise<{text:string;preferences?:NativePreferences}>

  open(id?: string, signal?: AbortSignal): Promise<NativeSession>
  inspect(sessionId: string, inputId: string): Promise<NativeResult | undefined>
}
/** Receipts track delivery only. DSH remains the execution and inbox authority. */
export interface Receipt {
  id: string
  inputId: string
  sessionId: string
  delivery: 'pending' | 'sending' | 'sent' | 'uncertain'
  result?: NativeResult | undefined
  media?: StoredMediaReceipt[] | undefined
}
export interface BindingState {scopeKey?:string|undefined; preferences?:NativePreferences|undefined; sessionId?: string | undefined; receipts: Receipt[]; legacyIdentity?: LegacySessionIdentity | undefined }
export interface BindingStore {
  read(): BindingState
  write(value: BindingState): Promise<void>
}

/** Keep every unsettled receipt and the most recent settled ones; older ids are provider-deduped. */
const SENT_KEEP = 512
function prune(receipts: Receipt[]): Receipt[] {
  const sent = receipts.filter(receipt => receipt.delivery === 'sent')
  if (sent.length <= SENT_KEEP) return receipts
  const keep = new Set(sent.slice(-SENT_KEEP).map(receipt => receipt.id))
  return receipts.filter(receipt => receipt.delivery !== 'sent' || keep.has(receipt.id))
}

/** One verified channel binding. No session adoption, cross-chat switch, or prompt replay. */
export class ChannelBridge {
  private session: NativeSession | undefined
  private tail = Promise.resolve()
  private readonly work = new Set<Promise<void>>()
  private readonly receiving = new Set<string>()
  private readonly bindingStop = new AbortController()
  private closed = false
  private generation = 0
  private connected = true
  private readonly interactions = new ChannelInteractions(() => this.connected && !this.closed)
  constructor(private readonly host: NativeHost, private readonly store: BindingStore) { }
  setConnected(healthy: boolean): void {this.connected=healthy;if(!healthy)this.interactions.cancel()}
  async approveShared(scope: ApprovalInteraction, destination: () => Promise<ChannelMessage>, settled: Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (!this.connected || this.closed || this.store.read().sessionId !== scope.sessionId) return 'unavailable'
    return this.interactions.approval(scope, await destination(), settled)
  }
  async deliverExternal(message:ChannelMessage,sessionId:string,result:NativeResult):Promise<void>{
    let receipt:Receipt|undefined
    await this.serial(async()=>{
      if(this.closed||!this.connected||this.store.read().sessionId!==sessionId||this.store.read().receipts.some(r=>r.id===message.id))return
      receipt={id:message.id,inputId:message.id,sessionId,delivery:'pending',result}
      await this.replace(receipt)
    })
    if(receipt)await this.deliver(receipt,message)
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn)
    this.tail = next.then(() => { }, () => { })
    return next
  }
  /** Recovery never resubmits input or retries an ambiguous external send. */
  recover(delivery: (id: string) => Promise<ChannelMessage>): Promise<void> {
    if (this.closed) return Promise.resolve()
    const work = this.recoverPending(delivery)
    this.work.add(work)
    void work.finally(() => this.work.delete(work)).catch(() => { })
    return work
  }
  private async recoverPending(delivery: (id: string) => Promise<ChannelMessage>): Promise<void> {
    {
      for (let receipt of this.store.read().receipts) {
        if (this.closed) return
        if (receipt.media?.some(m => m.delivery === 'sending')) {
          receipt = { ...receipt, media: receipt.media.map(m => m.delivery === 'sending' ? { ...m, delivery: 'uncertain' } : m) }
          await this.serial(() => this.replace(receipt))
        }
        if (receipt.delivery === 'sent' || receipt.delivery === 'uncertain') continue
        if (receipt.delivery === 'sending') {
          await this.serial(() => this.replace({ ...receipt, delivery: 'uncertain' }))
          continue
        }
        const result = receipt.result ?? await this.host.inspect(receipt.sessionId, receipt.inputId)
          ?? { text: 'DSH 上次执行未确认结束；请检查会话后重新提交。未自动重跑。', reason: 'interrupted' }
        if (this.closed) return
        const ready = { ...receipt, result }
        await this.serial(() => this.replace(ready))
        await this.deliver(ready, await delivery(receipt.id))
      }
    }
  }
  /** Resolve after durable admission, keeping the channel free for /cancel. */
  async receive(message: ChannelMessage): Promise<void> {
    if (this.closed || !message.text.trim() || this.receiving.has(message.id) || this.store.read().receipts.some(r => r.id === message.id)) return
    this.receiving.add(message.id)
    try {
      const command = message.text.trim()
      if (command === '/cancel' || command === '/stop') { this.generation++; this.interactions.cancel(); this.session?.cancel() }
      const generation = this.generation
      let reply: Receipt | undefined
      await this.serial(async () => {
        if (this.closed || this.store.read().receipts.some(r => r.id === message.id)) return
        const text = message.text.trim()
        if (/^\/(approve|deny|answer)(?:\s|$)/.test(text)) {
          let receipt:Receipt={id:message.id,inputId:randomUUID(),sessionId:this.store.read().sessionId ?? '',delivery:'pending',result:{text:'交互回复已接收。',reason:'command'}}
          await this.replace(receipt)
          let response:string,accepted=false
          try {response=this.interactions.reply(text);accepted=true} catch(error) {response=error instanceof Error?error.message:'交互回复无效。'}
          receipt={...receipt,result:{text:response,reason:'command'}}
          await this.replace(receipt)
          // Accept only after the broker consumed a valid one-time request.
          // A slow/failing QQ callback must not change the native decision.
          if(message.acknowledgeDecision)await bounded(message.acknowledgeDecision(accepted),2500,this.bindingStop.signal).catch(()=>{})
          reply=receipt;return
        }
        if (message.commandChannel === 'qqbot' && /^\/(new|reset|clear|compact|model|preset|bot-status|bot-help|bot-settings)(?:\s|$)/.test(text)) {
          let result: string
          if (['/new','/reset','/clear'].includes(text)) {
            this.generation++;this.interactions.cancel();this.session?.cancel();await this.session?.close();this.session=undefined
            const {sessionId:_,...state}=this.store.read();await this.store.write(state)
            result='已开启新会话。历史会话保留。'
          } else if (text==='/bot-help') result='/new (/reset /clear) 新会话；/compact 压缩；/model 可点击模型列表；/preset [id]（新会话生效）；/stop；/bot-ping；/bot-version；/bot-me；/bot-status；/bot-settings 设置入口。审批与问答沿用 DSH 的单次请求凭据。'
          else {
            if(text==='/compact'&&this.store.read().sessionId&&(!this.session||this.session.isLive?.()===false)){this.host.configure?.(this.store.read().preferences??{});this.session=await this.host.open(this.store.read().sessionId,this.bindingStop.signal)}
            const outcome=await this.host.command?.(text,this.store.read().sessionId,this.store.read().preferences??{})
            result=outcome?.text??'当前宿主未提供此命令能力。'
            if(outcome?.preferences){await this.store.write({...this.store.read(),preferences:outcome.preferences});this.host.configure?.(outcome.preferences)}
          }
          reply={id:message.id,inputId:randomUUID(),sessionId:this.store.read().sessionId??'',delivery:'pending',result:{text:result,reason:'command'}}
          await this.replace(reply);return
        }
        if (['/cancel', '/stop', '/status', '/help'].includes(text)) {
          const result = text === '/status' ? `DSH 会话：${this.store.read().sessionId ?? '尚未创建'}`
            : text === '/help' ? '发送文字任务；/cancel 取消；/status 查看会话。审批用 /approve 或 /deny；问答用 /answer，必须携带请求凭据。'
              : '已请求 DSH 取消本渠道工作。'
          // Commands are deduplicated too; cancellation bypasses the execution queue.
          const receipt: Receipt = { id: message.id, inputId: randomUUID(), sessionId: this.store.read().sessionId ?? '', delivery: 'pending', result: { text: result, reason: 'command' } }
          await this.replace(receipt)
          if (text === '/cancel' || text === '/stop') this.session?.cancel()
          reply = receipt
          return
        }
        if (!this.session || this.session.isLive?.() === false) {
          await this.session?.close()
          this.host.configure?.(this.store.read().preferences??{})
          this.session = await this.host.open(this.store.read().sessionId, this.bindingStop.signal)
        }
        const state = this.store.read()
        await this.store.write({ ...state, sessionId: this.session.id })
        const receipt: Receipt = { id: message.id, inputId: randomUUID(), sessionId: this.session.id, delivery: 'pending' }
        await this.replace(receipt)
        const session = this.session
        let streamed=false, streamChain=Promise.resolve()
        const stream=message.progressText ? (text:string)=>{
          streamChain=streamChain.then(async()=>{
            if(this.closed||generation!==this.generation)return
            if(!streamed){await this.serial(async()=>{const current=this.store.read().receipts.find(r=>r.id===receipt.id);if(current?.delivery!=='pending')throw new Error('Delivery already claimed');await this.replace({...current,delivery:'sending'})});streamed=true}
            await message.progressText!(text)
          })
          void streamChain.catch(()=>{})
        } : undefined
        const notice=message.commandChannel==='qqbot' ? async(text:string)=>{if(!this.closed&&generation===this.generation&&this.connected)await bounded(message.send(text),30000,this.bindingStop.signal)} : undefined
        const operation = generation !== this.generation || this.closed
          ? { admitted: Promise.resolve(), result: Promise.resolve({ text: '已取消。', reason: 'interrupted' }) }
          : session.submit(receipt.inputId, message.text, () => {}, {
            question:request => this.interactions.question({...request,current:()=>request.current() && generation===this.generation && this.session===session && !this.closed},message),
          }, request => this.sendMedia(receipt.id, session, generation, message, request), stream, notice)
        const job = this.execute(operation.result, receipt, message, async()=>{await streamChain;return streamed})
        this.work.add(job)
        void job.finally(() => this.work.delete(job)).catch(() => { })
        await operation.admitted
        if (generation !== this.generation || this.closed) session.cancel()
      })
      if (reply) await this.deliver(reply, message)
    } finally { this.receiving.delete(message.id) }
  }
  private async execute(resultPromise: Promise<NativeResult>, receipt: Receipt, message: ChannelMessage, streamed:()=>Promise<boolean> = async()=>false): Promise<void> {
    const result = await message.responding(() => resultPromise)
      .catch(() => ({ text: 'DSH 执行未确认完成；请检查会话。未自动重跑。', reason: 'interrupted' }))
    let started=false,failed=false
    try{started=await streamed()}catch{started=true;failed=true}
    const ready = { ...receipt, result, delivery:started?'sending' as const:'pending' as const }
    await this.serial(() => this.replace(ready))
    if(started){
      let delivery:'sent'|'uncertain'='uncertain'
      try{if(!failed&&!this.closed&&message.completeText){await bounded(message.completeText(result.text||`DSH 已结束：${result.reason}`),30000,this.bindingStop.signal);delivery='sent'}}catch{}
      await this.serial(()=>this.replace({...ready,delivery}))
    }else if (!this.closed) await this.deliver(ready, message)
  }
  async deliverExternalMedia(message:ChannelMessage,request:MediaInteraction):Promise<MediaDeliveryResult>{
    const id=`qq-present:${request.sessionId}:${request.callId}`
    await this.serial(async()=>{
      if(this.closed||this.store.read().sessionId!==request.sessionId||!request.current())throw new Error('External media owner mismatch')
      if(!this.store.read().receipts.some(r=>r.id===id))await this.replace({id,inputId:request.inputId,sessionId:request.sessionId,delivery:'sent'})
    })
    return this.sendMedia(id,undefined,this.generation,message,request)
  }
  private async sendMedia(receiptId: string, session: NativeSession|undefined, generation: number, message: ChannelMessage, request: MediaInteraction): Promise<MediaDeliveryResult> {
    const current = () => !this.closed && this.connected && generation === this.generation && (session?this.session===session:this.store.read().sessionId===request.sessionId) && request.current() && !request.signal.aborted
    if (!current()) throw new Error('Channel media delivery scope is no longer active.')
    const mode = request.kind === 'voice' && (message.nativeVoice === false || message.supportsNativeVoice?.(request.media) === false) ? 'file' : request.kind
    const item: StoredMediaReceipt = { callId: request.callId, name: request.media.name, bytes: request.media.bytes.byteLength, mode, delivery: 'sending' }
    const prior = await this.serial(async () => {
      if (!current()) throw new Error('Channel media delivery scope is no longer active.')
      const receipt = this.store.read().receipts.find(r => r.id === receiptId)
      if (!receipt || receipt.inputId !== request.inputId || receipt.sessionId !== request.sessionId) throw new Error('Channel media owner mismatch.')
      const existing = receipt.media?.find(m => m.callId === request.callId)
      if (existing) return existing
      if ((receipt.media?.length ?? 0) >= 32) throw new Error('Media send limit reached for this input (32).')
      await this.replace({ ...receipt, media: [...(receipt.media ?? []), item] })
      return undefined
    })
    if (prior) return { name: prior.name, bytes: prior.bytes, mode: prior.mode, delivery: prior.delivery === 'sent' ? 'sent' : 'uncertain' }
    let delivery: 'sent' | 'uncertain' = 'uncertain'
    try {
      if (!current()) throw new Error('Channel media delivery cancelled.')
      const signal = AbortSignal.any([request.signal, this.bindingStop.signal, AbortSignal.timeout(30000)])
      const send = mode === 'voice' ? message.sendVoice.bind(message)
        : mode === 'image' ? (message.sendImage ?? message.sendFile).bind(message) : message.sendFile.bind(message)
      await bounded(send(request.media, signal), 30000, signal)
      delivery = 'sent'
    } catch { /* Ambiguous provider errors are quarantined, never retried. */ }
    await this.serial(async () => {
      const receipt = this.store.read().receipts.find(r => r.id === receiptId)
      if (!receipt) throw new Error('Channel media receipt missing.')
      await this.replace({ ...receipt, media: receipt.media!.map(m => m.callId === request.callId ? { ...m, delivery } : m) })
    })
    return { name: item.name, bytes: item.bytes, mode, delivery,
      ...(request.kind === 'voice' && mode === 'file' ? { reason: 'This channel or audio payload cannot use native voice; audio-file delivery was selected.' } : {}) }
  }
  private async replace(receipt: Receipt): Promise<void> {
    const state = this.store.read()
    const previous = state.receipts.find(r => r.id === receipt.id)
    const merged = { ...receipt, ...(receipt.media === undefined && previous?.media !== undefined ? { media: previous.media } : {}) }
    await this.store.write({ ...state, receipts: prune([...state.receipts.filter(r => r.id !== receipt.id), merged]) })
  }
  private async deliver(receipt: Receipt, message: ChannelMessage): Promise<void> {
    if (!receipt.result || this.closed) return
    const claimed = await this.serial(async () => {
      const current = this.store.read().receipts.find(r => r.id === receipt.id)
      if (current?.delivery !== 'pending') return false
      if (receipt.result?.suppressed) {
        await this.replace({ ...receipt, delivery: 'sent' }); return false
      }
      await this.replace({ ...receipt, delivery: 'sending' })
      return true
    })
    if (!claimed) return
    let delivery: Receipt['delivery'] = 'sent'
    try { await bounded(message.send(receipt.result.text || `DSH 已结束：${receipt.result.reason}`), 30000, this.bindingStop.signal) }
    catch { delivery = 'uncertain' }
    // A crash or failed commit here leaves 'sending'; recovery quarantines it.
    await this.serial(() => this.replace({ ...receipt, delivery }))
  }
  async drain(): Promise<void> { await this.tail; await Promise.all([...this.work]); await this.tail }
  async close(): Promise<void> {
    this.closed = true; this.generation++; this.interactions.cancel(); this.bindingStop.abort()
    this.session?.cancel()
    await this.tail
    this.session?.cancel()
    await this.session?.close()
    await this.drain()
  }
}

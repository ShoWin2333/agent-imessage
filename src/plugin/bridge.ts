import { randomUUID } from 'node:crypto'
import { ChannelInteractions } from './interactions.js'
import { bounded } from './delivery.js'
import type { InteractionHandlers } from './interaction-types.js'
import type { ChannelMessage } from '../channels/types.js'

export interface NativeResult { text: string; reason: string; suppressed?: boolean | undefined }
export interface NativeSession {
  readonly id: string
  submit(id: string, text: string, progress: () => void, interactions?: InteractionHandlers): { admitted: Promise<void>; result: Promise<NativeResult> }
  cancel(): void
  close(): Promise<void>
}
export interface NativeHost {
  open(id?: string): Promise<NativeSession>
  inspect(sessionId: string, inputId: string): Promise<NativeResult | undefined>
}
/** Receipts track delivery only. DSH remains the execution and inbox authority. */
export interface Receipt {
  id: string
  inputId: string
  sessionId: string
  delivery: 'pending' | 'sending' | 'sent' | 'uncertain'
  result?: NativeResult | undefined
}
export interface BindingState { sessionId?: string | undefined; receipts: Receipt[] }
export interface BindingStore {
  read(): BindingState
  write(value: BindingState): Promise<void>
}

/** One verified channel binding. No session adoption, cross-chat switch, or prompt replay. */
export class ChannelBridge {
  private session: NativeSession | undefined
  private tail = Promise.resolve()
  private readonly work = new Set<Promise<void>>()
  private readonly receiving = new Set<string>()
  private readonly deliveryStop = new AbortController()
  private closed = false
  private generation = 0
  private connected = true
  private readonly interactions = new ChannelInteractions(() => this.connected && !this.closed)
  constructor(private readonly host: NativeHost, private readonly store: BindingStore) { }
  setConnected(healthy: boolean): void {this.connected=healthy;if(!healthy)this.interactions.cancel()}
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
      for (const receipt of this.store.read().receipts) {
        if (this.closed) return
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
        if (this.store.read().receipts.length >= 10000) throw new Error('Receipt capacity reached; archive this binding before accepting more work')
        const text = message.text.trim()
        if (/^\/(approve|deny|answer)(?:\s|$)/.test(text)) {
          let receipt:Receipt={id:message.id,inputId:randomUUID(),sessionId:this.store.read().sessionId ?? '',delivery:'pending',result:{text:'交互回复已接收。',reason:'command'}}
          await this.replace(receipt)
          let response:string
          try {response=this.interactions.reply(text)} catch(error) {response=error instanceof Error?error.message:'交互回复无效。'}
          receipt={...receipt,result:{text:response,reason:'command'}}
          await this.replace(receipt);reply=receipt;return
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
        this.session ??= await this.host.open(this.store.read().sessionId)
        const state = this.store.read()
        await this.store.write({ ...state, sessionId: this.session.id })
        const receipt: Receipt = { id: message.id, inputId: randomUUID(), sessionId: this.session.id, delivery: 'pending' }
        await this.replace(receipt)
        const session = this.session
        const operation = generation !== this.generation || this.closed
          ? { admitted: Promise.resolve(), result: Promise.resolve({ text: '已取消。', reason: 'interrupted' }) }
          : session.submit(receipt.inputId, message.text, () => {}, {
            approval:request => this.interactions.approval({...request,current:()=>request.current() && generation===this.generation && this.session===session && !this.closed},message),
            question:request => this.interactions.question({...request,current:()=>request.current() && generation===this.generation && this.session===session && !this.closed},message),
          })
        const job = this.execute(operation.result, receipt, message)
        this.work.add(job)
        void job.finally(() => this.work.delete(job)).catch(() => { })
        await operation.admitted
        if (generation !== this.generation || this.closed) session.cancel()
      })
      if (reply) await this.deliver(reply, message)
    } finally { this.receiving.delete(message.id) }
  }
  private async execute(resultPromise: Promise<NativeResult>, receipt: Receipt, message: ChannelMessage): Promise<void> {
    const result = await message.responding(() => resultPromise)
      .catch(() => ({ text: 'DSH 执行未确认完成；请检查会话。未自动重跑。', reason: 'interrupted' }))
    const ready = { ...receipt, result }
    await this.serial(() => this.replace(ready))
    if (!this.closed) await this.deliver(ready, message)
  }
  private async replace(receipt: Receipt): Promise<void> {
    const state = this.store.read()
    await this.store.write({ ...state, receipts: [...state.receipts.filter(r => r.id !== receipt.id), receipt] })
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
    try { await bounded(message.send(receipt.result.text || `DSH 已结束：${receipt.result.reason}`), 30000, this.deliveryStop.signal) }
    catch { delivery = 'uncertain' }
    // A crash or failed commit here leaves 'sending'; recovery quarantines it.
    await this.serial(() => this.replace({ ...receipt, delivery }))
  }
  async drain(): Promise<void> { await this.tail; await Promise.all([...this.work]); await this.tail }
  async close(): Promise<void> {
    this.closed = true; this.generation++; this.interactions.cancel(); this.deliveryStop.abort()
    this.session?.cancel()
    await this.tail
    this.session?.cancel()
    await this.session?.close()
    await this.drain()
  }
}

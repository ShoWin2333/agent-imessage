import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import type { WeixinCredential } from './config.js'
import { WeixinApi, WeixinError, WEIXIN_BASE, apiBase, pause, string } from '../channels/weixin-api.js'

type Phase = 'pending' | 'scanned' | 'needs_verification' | 'connected' | 'expired' | 'failed' | 'cancelled'
interface Attempt { id: string; phase: Phase; qr: string; controller: AbortController; expiresAt: number; accountId?: string; error?: string; code: string }
/** QR and bot credentials stay local; the UI sees only a rendered QR and public status. */
export class WeixinLogin {
  private attempt: Attempt | undefined
  private task: Promise<void> | undefined
  constructor(private readonly save: (credential: WeixinCredential) => Promise<void>, private readonly api = new WeixinApi()) {}
  snapshot() {
    const a = this.attempt
    return a ? {id:a.id,phase:a.phase,qr:['pending','scanned','needs_verification'].includes(a.phase) ? a.qr : '',expiresAt:a.expiresAt,accountId:a.accountId,error:a.error} : {phase:'idle'}
  }
  async begin() {
    await this.cancel()
    const controller = new AbortController()
    const a: Attempt = {id:randomUUID(),phase:'pending',qr:'',controller,expiresAt:Date.now()+5*60_000,code:''}
    this.attempt = a
    try {
      const qr = await this.api.begin(controller.signal)
      a.qr = await QRCode.toDataURL(qr.url,{width:280,margin:2,errorCorrectionLevel:'M'})
      this.task = this.poll(a,qr.qrcode).catch(error => {
        if (controller.signal.aborted) return
        a.phase = 'failed'; a.error = error instanceof WeixinError ? error.message : '微信绑定失败，请重试。'
      })
    } catch (error) { a.phase = 'failed'; throw error }
  }
  verify(id: string, code: string) {
    if (!this.attempt || this.attempt.id !== id || this.attempt.phase !== 'needs_verification' || !/^\d{4,12}$/.test(code)) throw new Error('Invalid pairing code')
    this.attempt.code = code
  }
  async cancel() {
    this.attempt?.controller.abort()
    if (this.attempt && !['connected','failed','expired'].includes(this.attempt.phase)) this.attempt.phase = 'cancelled'
    await this.task
  }
  private async poll(a: Attempt, qrcode: string) {
    let base = WEIXIN_BASE
    const signal = AbortSignal.any([a.controller.signal,AbortSignal.timeout(5*60_000)])
    while (!signal.aborted && Date.now() < a.expiresAt) {
      let result
      const code = a.code
      a.code = ''
      try { result = await this.api.poll(qrcode,base,code,signal) }
      catch (error) { if (error instanceof WeixinError && error.code === 'timeout') continue; if (signal.aborted && !a.controller.signal.aborted) { a.phase='expired'; return }; throw error }
      if (signal.aborted) return
      switch (result.status) {
        case 'wait': a.phase='pending'; break
        case 'scaned': a.phase='scanned'; break
        case 'need_verifycode': a.phase='needs_verification'; break
        case 'scaned_but_redirect': base = apiBase(string(result.redirect_host)); a.phase='scanned'; break
        case 'expired': a.phase='expired'; return
        case 'confirmed': {
          const token=string(result.bot_token), accountId=string(result.ilink_bot_id), ownerUserId=string(result.ilink_user_id)
          if (!token || !accountId || !ownerUserId) throw new WeixinError('credentials','微信返回的绑定凭据不完整。')
          await this.save({token,accountId,ownerUserId,baseUrl:result.baseurl ? apiBase(string(result.baseurl)) : base})
          a.accountId=accountId; a.phase='connected'; return
        }
        case 'binded_redirect': throw new WeixinError('bound','微信提示账号已绑定，请选择本机已有机器人；如无凭据，请在微信解绑后重试。')
        case 'verify_code_blocked': throw new WeixinError('verification','配对码多次错误，请重新扫码。')
        default: throw new WeixinError('status','无法识别微信绑定状态，请重试。')
      }
      await pause(signal)
    }
    if (!a.controller.signal.aborted) a.phase='expired'
  }
}

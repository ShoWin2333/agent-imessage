import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WeixinCredential } from '../app/config.js'
import type { OutboundMediaPayload } from '../media.js'

// iLink wire format referenced from xmanrui/dsh-im (MIT); see THIRD_PARTY_NOTICES.md.
export const WEIXIN_BASE = 'https://ilinkai.weixin.qq.com/'
export class WeixinError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function weixinUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password ||
    !['weixin.qq.com', 'wechat.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new WeixinError('url', '微信返回了不受信任的地址。')
  return url.href
}
export function apiBase(value: string): string {
  const url = new URL(weixinUrl(value.includes('://') ? value : `https://${value}`))
  url.search = ''; url.hash = ''; url.pathname = '/'
  return url.href
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function string(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }
const baseInfo = { channel_version: '2.4.6', bot_agent: 'AgentGateway/1.0.0' }

export class WeixinApi {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  async request(base: string, endpoint: string, body: unknown, token = '', signal?: AbortSignal, timeout = 35_000): Promise<Record<string, unknown>> {
    const url = new URL(endpoint, apiBase(base))
    const headers: Record<string,string> = { 'iLink-App-Id':'bot', 'iLink-App-ClientVersion':String((2 << 16) | (4 << 8) | 6) }
    if (body !== undefined) { headers['content-type'] = 'application/json'; headers.AuthorizationType = 'ilink_bot_token'; headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') }
    if (token) { headers.Authorization = `Bearer ${token}`; headers.AuthorizationType = 'ilink_bot_token'; headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') }
    const timeoutSignal = AbortSignal.timeout(timeout)
    let response: Response
    try {
      response = await this.fetcher(url, {method:body === undefined ? 'GET':'POST', headers,
        ...(body === undefined ? {} : {body:JSON.stringify(body)}), redirect:'error',
        signal:signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal})
    } catch {
      if (signal?.aborted) throw signal.reason
      throw new WeixinError(timeoutSignal.aborted ? 'timeout':'network', '微信连接暂时不可用。')
    }
    if (!response.ok) { await response.body?.cancel(); throw new WeixinError(response.status === 401 || response.status === 403 ? 'auth':'http', '微信请求失败，请检查连接或重新扫码。') }
    const reader = response.body?.getReader()
    if (!reader) throw new WeixinError('response', '微信返回了无效响应。')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) throw new Error('limit'); chunks.push(next.value) }
      const result = record(JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value, context?: {source?: string}) => {
        if (key === 'message_id' && typeof value === 'number' && !Number.isSafeInteger(value)) {
          if (!context?.source || !/^\d+$/.test(context.source)) throw new Error('Invalid message ID')
          return context.source
        }
        return value
      }))
      for (const key of ['ret','errcode']) if (result[key] !== undefined && String(result[key]) !== '0') {
        throw new WeixinError(String(result[key]) === '-14' ? 'auth':'rejected', String(result[key]) === '-14' ? '微信凭据已失效，请重新扫码绑定。':'微信拒绝了请求。')
      }
      return result
    } catch (error) {
      if (error instanceof WeixinError) throw error
      if (signal?.aborted) throw signal.reason
      throw new WeixinError(timeoutSignal.aborted ? 'timeout':'response', '微信响应读取失败。')
    } finally { await reader.cancel().catch(() => {}) }
  }
  async begin(signal?: AbortSignal) {
    const result = await this.request(WEIXIN_BASE, 'ilink/bot/get_bot_qrcode?bot_type=3', {local_token_list:[]}, '', signal, 10_000)
    const qrcode = string(result.qrcode), url = weixinUrl(string(result.qrcode_img_content))
    if (!qrcode) throw new WeixinError('qr', '微信未返回二维码，请重试。')
    return {qrcode, url}
  }
  poll(qrcode: string, base: string, verifyCode: string, signal: AbortSignal) {
    return this.request(base, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}`:''}`, undefined, '', signal)
  }
  notify(c: WeixinCredential, state: 'start' | 'stop', signal: AbortSignal) {
    return this.request(c.baseUrl,`ilink/bot/msg/notify${state}`,{base_info:baseInfo},c.token,signal,10_000)
  }
  async updates(credential: WeixinCredential, cursor: string, signal: AbortSignal) {
    try { return await this.request(credential.baseUrl, 'ilink/bot/getupdates', {get_updates_buf:cursor, base_info:baseInfo}, credential.token, signal) }
    catch (error) { if (error instanceof WeixinError && error.code === 'timeout') return {msgs:[], get_updates_buf:cursor}; throw error }
  }
  send(credential: WeixinCredential, user: string, context: string, text: string, signal: AbortSignal) {
    return this.sendItems(credential, user, context, [{type:1,text_item:{text}}], signal)
  }
  private sendItems(c: WeixinCredential, user: string, context: string, items: unknown[], signal: AbortSignal) {
    return this.request(c.baseUrl, 'ilink/bot/sendmessage', {msg:{from_user_id:'',to_user_id:user,client_id:`gateway-${randomUUID()}`,message_type:2,message_state:2,item_list:items,context_token:context},base_info:baseInfo},c.token,signal)
  }
  async typing(c: WeixinCredential, user: string, context: string, signal: AbortSignal) {
    const config = await this.request(c.baseUrl,'ilink/bot/getconfig',{ilink_user_id:user,context_token:context,base_info:baseInfo},c.token,signal,10_000)
    const ticket = string(config.typing_ticket)
    if (!ticket) return
    await this.request(c.baseUrl,'ilink/bot/sendtyping',{ilink_user_id:user,typing_ticket:ticket,status:1,base_info:baseInfo},c.token,signal,10_000)
  }
  async file(c: WeixinCredential, user: string, context: string, media: OutboundMediaPayload, signal: AbortSignal) {
    const bytes = Buffer.from(media.bytes), key = randomBytes(16), filekey = randomBytes(16).toString('hex')
    const cipher = createCipheriv('aes-128-ecb',key,null)
    const encrypted = Buffer.concat([cipher.update(bytes),cipher.final()])
    const result = await this.request(c.baseUrl,'ilink/bot/getuploadurl',{filekey,media_type:3,to_user_id:user,rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),filesize:encrypted.length,no_need_thumb:true,aeskey:key.toString('hex'),base_info:baseInfo},c.token,signal)
    const url = new URL(string(result.upload_full_url) || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(string(result.upload_param))}&filekey=${filekey}`)
    if (url.origin !== 'https://novac2c.cdn.weixin.qq.com' || url.pathname !== '/c2c/upload' || url.username || url.password) throw new WeixinError('url','微信上传地址无效。')
    const response = await this.fetcher(url,{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array(encrypted),redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])})
    const query = response.headers.get('x-encrypted-param'); await response.body?.cancel()
    if (!response.ok || !query) throw new WeixinError('upload','微信文件上传失败。')
    await this.sendItems(c,user,context,[{type:4,file_item:{file_name:media.name,len:String(bytes.length),media:{encrypt_query_param:query,aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1}}}],signal)
  }
}

export async function pause(signal: AbortSignal, ms = 1000) { await delay(ms, undefined, {signal}) }

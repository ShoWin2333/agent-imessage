import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { AppType, Client, defaultHttpInstance, Domain, EventDispatcher, WSClient, type EventHandles, type HttpInstance, type HttpRequestOptions, type Logger } from '@larksuiteoapi/node-sdk'
import type { OutboundMediaPayload } from '../media.js'
import { pause } from './weixin-api.js'

export type FeishuEvent = Parameters<NonNullable<EventHandles['im.message.receive_v1']>>[0]
export interface FeishuConnection {
  start(): Promise<void>
  close(): void
  send(text: string, signal: AbortSignal): Promise<void>
  upload(media: OutboundMediaPayload, image: boolean, signal: AbortSignal): Promise<void>
}
export interface FeishuCallbacks {
  ready(): void
  reconnecting(): void
  failed(): void
  message(event: FeishuEvent): Promise<void>
}
export type FeishuClientFactory = (appId: string, secret: string, owner: string, signal: AbortSignal, callbacks: FeishuCallbacks) => FeishuConnection
// SDK errors can contain authorization headers, request bodies and websocket tickets.
const silent: Logger = {error() {}, warn() {}, info() {}, debug() {}, trace() {}}
const signals = new AsyncLocalStorage<AbortSignal>()

/** Per-client transport; never mutate the SDK's global HTTP instance. */
export function feishuHttp(lifetime: AbortSignal): HttpInstance {
  const request = async <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
    const signal = AbortSignal.any([lifetime, signals.getStore() ?? lifetime])
    signal.throwIfAborted()
    // SDK's interceptor unwraps response.data; Axios' generic signature does not model it.
    return defaultHttpInstance.request({...options, signal, timeout:15_000, maxRedirects:0}) as Promise<R>
  }
  return {
    request,
    get:(url, options) => request({...options, url, method:'GET'}),
    delete:(url, options) => request({...options, url, method:'DELETE'}),
    head:(url, options) => request({...options, url, method:'HEAD'}),
    options:(url, options) => request({...options, url, method:'OPTIONS'}),
    post:(url, data, options) => request({...options, url, data, method:'POST'}),
    put:(url, data, options) => request({...options, url, data, method:'PUT'}),
    patch:(url, data, options) => request({...options, url, data, method:'PATCH'}),
  }
}

interface Response {code?: number | undefined}
/** Retry only explicit rate-limit rejections, never an ambiguous timeout/5xx. */
export async function feishuRequest<T extends Response>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt=0; ; attempt++) {
    signal.throwIfAborted()
    let response: T | undefined, limited = false
    try { response = await operation() }
    catch (error) {
      limited = (error as {response?: {status?: number}} | undefined)?.response?.status === 429
      if (!limited) throw new Error('Feishu request failed; delivery may be uncertain. Check app permissions and limits.')
    }
    signal.throwIfAborted()
    if (response?.code === 0) return response
    limited ||= !!response && [99991400,99991429].includes(response.code ?? -1)
    if (!limited || attempt >= 2) throw new Error('Feishu rejected the request. Check app permissions and limits.')
    await pause(signal, 1000 * 2 ** attempt)
  }
}

/** Official SDK owns token caching, websocket authentication, heartbeats and reconnect. */
export const createFeishuClient: FeishuClientFactory = (appId, appSecret, owner, signal, callbacks) => {
  const httpInstance = feishuHttp(signal)
  const options = {appId, appSecret, domain:Domain.Feishu, logger:silent, httpInstance}
  const client = new Client({...options, appType:AppType.SelfBuild})
  const dispatcher = new EventDispatcher({logger:silent}).register({'im.message.receive_v1':callbacks.message})
  const ws = new WSClient({...options, autoReconnect:true, handshakeTimeoutMs:15_000, wsConfig:{pingTimeout:30},
    onReady:callbacks.ready, onReconnected:callbacks.ready, onReconnecting:callbacks.reconnecting, onError:callbacks.failed})
  const send = (type: string, content: object, cancellation: AbortSignal) => signals.run(cancellation, async () => {
    const uuid = randomUUID()
    await feishuRequest(() => client.im.message.create({params:{receive_id_type:'open_id'},
      data:{receive_id:owner, msg_type:type, content:JSON.stringify(content), uuid}}), cancellation)
  })
  return {
    start:() => ws.start({eventDispatcher:dispatcher}),
    close:() => ws.close({force:true}),
    send:(text, cancellation) => send('text', {text}, cancellation),
    upload:(media, image, cancellation) => signals.run(cancellation, async () => {
      try {
        const result = image
          ? await client.im.image.create({data:{image_type:'message',image:media.bytes}})
          : await client.im.file.create({data:{file_type:'stream',file_name:media.name,file:media.bytes}})
        cancellation.throwIfAborted()
        const key = image ? (result as {image_key?:string} | null)?.image_key : (result as {file_key?:string} | null)?.file_key
        if (!key) throw new Error('Feishu upload did not return an attachment key')
        await send(image ? 'image' : 'file', image ? {image_key:key} : {file_key:key}, cancellation)
      } catch {
        cancellation.throwIfAborted()
        throw new Error('Feishu attachment delivery failed; check app permissions and limits. Delivery may be uncertain.')
      }
    }),
  }
}

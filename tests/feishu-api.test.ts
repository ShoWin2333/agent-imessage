import {afterEach,expect,it,vi} from 'vitest'
import {defaultHttpInstance,WSClient,type EventDispatcher} from '@larksuiteoapi/node-sdk'
import {createFeishuClient,feishuHttp,feishuRequest,type FeishuCallbacks} from '../src/channels/feishu-api.js'
import * as waiting from '../src/channels/weixin-api.js'
const cleanup:Array<()=>void>=[]
afterEach(()=>{cleanup.splice(0).reverse().forEach(fn=>fn());vi.restoreAllMocks()})
const callbacks=():FeishuCallbacks=>({ready:vi.fn(),reconnecting:vi.fn(),failed:vi.fn(),message:vi.fn(async()=>{})})
let sequence=0
function setup(request?:(options:any)=>Promise<any>){
  const appId=`cli_${(++sequence).toString(16).padStart(16,'0')}`,lifetime=new AbortController(),events=callbacks()
  const http=vi.spyOn(defaultHttpInstance,'request').mockImplementation((request??(async options=>{
    const url=String(options.url)
    if(url.includes('/auth/'))return {code:0,tenant_access_token:'synthetic-token',expire:3600}
    if(url.endsWith('/images'))return {code:0,data:{image_key:'img_synthetic'}}
    if(url.endsWith('/files'))return {code:0,data:{file_key:'file_synthetic'}}
    return {code:0,data:{message_id:'om_sent'}}
  })) as any)
  const start=vi.spyOn(WSClient.prototype,'start').mockResolvedValue()
  const close=vi.spyOn(WSClient.prototype,'close')
  const connection=createFeishuClient(appId,'synthetic-app-secret','ou_synthetic',lifetime.signal,events)
  cleanup.push(()=>{lifetime.abort();connection.close()})
  return {connection,lifetime,events,http,start,close,appId}
}
it('uses the real SDK dispatcher and flattens app/tenant event headers',async()=>{
  const f=setup();await f.connection.start()
  expect(f.events.ready).not.toHaveBeenCalled()
  const dispatcher=f.start.mock.calls[0]![0].eventDispatcher as EventDispatcher
  await dispatcher.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',app_id:f.appId,tenant_key:'tenant'},
    event:{sender:{sender_type:'user'},message:{message_id:'om_test'}}},{needCheck:false})
  expect(f.events.message).toHaveBeenCalledWith(expect.objectContaining({app_id:f.appId,tenant_key:'tenant',message:{message_id:'om_test'}}))
  expect(f.http).not.toHaveBeenCalled();f.connection.close();expect(f.close).toHaveBeenCalledWith({force:true})
})
it('uses SDK auth and fixed open_id recipient, stable uuid and UTF-8 plain text content',async()=>{
  const f=setup();await f.connection.send('Hello <at id="all">everyone</at>',f.lifetime.signal)
  const requests=f.http.mock.calls.map(([options])=>options)
  expect(requests).toHaveLength(2)
  const post=requests[1]!
  expect(post.url).toBe('https://open.feishu.cn/open-apis/im/v1/messages')
  expect(post.params).toEqual({receive_id_type:'open_id'})
  expect(post.data).toMatchObject({receive_id:'ou_synthetic',msg_type:'text',content:JSON.stringify({text:'Hello <at id="all">everyone</at>'}),uuid:expect.stringMatching(/^[0-9a-f-]{36}$/)})
  expect(post.timeout).toBe(15000);expect(post.maxRedirects).toBe(0);expect(post.signal).toBeInstanceOf(AbortSignal)
  f.lifetime.abort();expect(post.signal?.aborted).toBe(true)
  await expect(f.connection.send('stale',f.lifetime.signal)).rejects.toThrow()
  expect(f.http).toHaveBeenCalledTimes(2)
})
it('uploads through SDK multipart APIs, then sends only the returned media key to the owner',async()=>{
  const f=setup(),media={bytes:Buffer.from('synthetic'),name:'result.txt',mimeType:'text/plain'}
  await f.connection.upload(media,false,f.lifetime.signal);await f.connection.upload({...media,name:'image.png'},true,f.lifetime.signal)
  const requests=f.http.mock.calls.map(([options])=>options)
  const files=requests.find(r=>String(r.url).endsWith('/files'))!,images=requests.find(r=>String(r.url).endsWith('/images'))!
  expect(files.data).toMatchObject({file_type:'stream',file_name:'result.txt',file:media.bytes})
  expect(images.data).toMatchObject({image_type:'message',image:media.bytes})
  expect(files.headers?.['Content-Type']).toBe('multipart/form-data')
  const messages=requests.filter(r=>String(r.url).endsWith('/messages'))
  expect(messages.map(r=>r.data)).toMatchObject([{receive_id:'ou_synthetic',msg_type:'file',content:'{"file_key":"file_synthetic"}'},{receive_id:'ou_synthetic',msg_type:'image',content:'{"image_key":"img_synthetic"}'}])
})
it('cancels the per-send HTTP request independently and never sends a key after upload cancellation',async()=>{
  const cancellation=new AbortController()
  const f=setup(async options=>{
    if(String(options.url).includes('/auth/'))return {code:0,tenant_access_token:'synthetic-token',expire:3600}
    cancellation.abort();return {code:0,data:{file_key:'uploaded'}}
  })
  await expect(f.connection.upload({bytes:Buffer.from('file'),name:'x',mimeType:'text/plain'},false,cancellation.signal)).rejects.toThrow()
  const requests=f.http.mock.calls.map(([options])=>options)
  expect(requests).toHaveLength(2);expect(requests[1]!.signal?.aborted).toBe(true)
  expect(f.lifetime.signal.aborted).toBe(false)
})
it('redacts SDK upload failures and does not retry transport failures or business failures',async()=>{
  const f=setup(async options=>{
    if(String(options.url).includes('/auth/'))return {code:0,tenant_access_token:'synthetic-token',expire:3600}
    throw new Error('synthetic-secret Authorization request-body')
  })
  await expect(f.connection.upload({bytes:Buffer.from('file'),name:'x',mimeType:'text/plain'},false,f.lifetime.signal)).rejects.toThrow('Feishu attachment delivery failed')
  expect(f.http).toHaveBeenCalledTimes(2)
  await expect(f.connection.send('x',f.lifetime.signal)).rejects.toThrow('Feishu request failed')
  expect(f.http).toHaveBeenCalledTimes(3)
})
it('retries only explicit 429 responses with the same send uuid, bounded backoff and cancellation',async()=>{
  vi.spyOn(waiting,'pause').mockResolvedValue()
  let calls=0
  const f=setup(async options=>{
    if(String(options.url).includes('/auth/'))return {code:0,tenant_access_token:'synthetic-token',expire:3600}
    return ++calls===1?{code:99991400}:{code:0,data:{message_id:'om_sent'}}
  })
  await f.connection.send('limited',f.lifetime.signal)
  const sends=f.http.mock.calls.map(([options])=>options).filter(r=>String(r.url).endsWith('/messages'))
  expect(sends).toHaveLength(2);expect(sends[0]!.data.uuid).toBe(sends[1]!.data.uuid)
  expect(waiting.pause).toHaveBeenCalledWith(f.lifetime.signal,1000)
  const rejected=vi.fn(async()=>{throw {response:{status:429}}})
  await expect(feishuRequest(rejected,f.lifetime.signal)).rejects.toThrow('rejected');expect(rejected).toHaveBeenCalledTimes(3)
  for(const result of [{code:400},{code:500},undefined,null]) {
    const fn=vi.fn(async()=>result as any);await expect(feishuRequest(fn,f.lifetime.signal)).rejects.toThrow();expect(fn).toHaveBeenCalledOnce()
  }
  const controller=new AbortController(),fn=vi.fn(async()=>({code:99991400}))
  vi.mocked(waiting.pause).mockImplementationOnce(async()=>{controller.abort()})
  await expect(feishuRequest(fn,controller.signal)).rejects.toThrow();expect(fn).toHaveBeenCalledOnce()
})
it('bounds every SDK request and token method without mutating the shared HTTP client',async()=>{
  const controller=new AbortController(),original=defaultHttpInstance.post
  const request=vi.spyOn(defaultHttpInstance,'request').mockResolvedValue({code:0})
  const http=feishuHttp(controller.signal)
  await http.post('https://open.feishu.cn/token',{app_id:'synthetic'})
  expect(defaultHttpInstance.post).toBe(original)
  expect(request).toHaveBeenCalledWith(expect.objectContaining({method:'POST',timeout:15000,maxRedirects:0,signal:expect.any(AbortSignal)}))
  controller.abort();await expect(http.get('https://open.feishu.cn/token')).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
})

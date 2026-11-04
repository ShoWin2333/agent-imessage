import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDecipheriv, createHash } from 'node:crypto'
import { DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../src/media.js'
import { WeixinApi, WeixinError, weixinUrl } from '../src/channels/weixin-api.js'
import { WeixinAdapter, splitWeixinText } from '../src/channels/weixin.js'
import { type RouteState } from '../src/channels/state.js'
import type { ChannelMessage } from '../src/channels/types.js'
import { legacyCheckpoint, wasLegacyMessage } from '../src/plugin/legacy-checkpoint.js'
import { ChannelBridge, type BindingState, type NativeSession } from '../src/plugin/bridge.js'

beforeEach(()=>{vi.spyOn(WeixinApi.prototype,'notify').mockResolvedValue({ret:0})})
const cleanup: Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks()})
const credential={token:'private-bot-token',accountId:'bot@im.bot',ownerUserId:'owner@im.user',baseUrl:'https://ilinkai.weixin.qq.com/'}
const inbound=(id:string,text:string,extra={})=>({message_id:id,from_user_id:credential.ownerUserId,to_user_id:credential.accountId,message_type:1,context_token:'reply-context',item_list:[{type:1,text_item:{text}}],...extra})

it('uses iLink wire fields, local QR binding and authenticated outbound context',async()=>{
  const calls: Array<{url:string;init:RequestInit}>=[]
  const api=new WeixinApi((async(url,init)=>{
    calls.push({url:String(url),init:init!})
    return Response.json(String(url).includes('get_bot_qrcode') ? {qrcode:'qr-secret',qrcode_img_content:'https://weixin.qq.com/bind?code=secret'} : {ret:0})
  }) as typeof fetch)
  expect(await api.begin()).toEqual({qrcode:'qr-secret',url:'https://weixin.qq.com/bind?code=secret'})
  await api.send(credential,credential.ownerUserId,'context-private','hello',new AbortController().signal)
  expect(calls[0]!.url).toContain('ilink/bot/get_bot_qrcode?bot_type=3')
  expect(calls[0]!.init.redirect).toBe('error')
  expect(calls[1]!.init.headers).toMatchObject({Authorization:'Bearer private-bot-token',AuthorizationType:'ilink_bot_token'})
  expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({msg:{to_user_id:credential.ownerUserId,context_token:'context-private',message_type:2,item_list:[{type:1,text_item:{text:'hello'}}]}})
})
it('rejects untrusted provider URLs and turns expired tokens into a fixed public error',async()=>{
  for (const url of ['http://ilinkai.weixin.qq.com/','https://weixin.qq.com.evil.test/','https://user:pass@weixin.qq.com/','https://127.0.0.1/']) expect(()=>weixinUrl(url)).toThrow()
  const api=new WeixinApi((async()=>Response.json({ret:-14,errmsg:'private provider details'})) as typeof fetch)
  await expect(api.updates(credential,'',new AbortController().signal)).rejects.toMatchObject({code:'auth',message:'微信凭据已失效，请重新扫码绑定。'})
})
it('filters non-owner, bot, wrong-recipient and attachment messages; persists poll cursor and bounds replies',async()=>{
  const api=new WeixinApi(), messages:ChannelMessage[]=[], store={state:{seen:[]} as RouteState,save:vi.fn(async()=>{})}
  vi.spyOn(api,'updates').mockResolvedValueOnce({msgs:[inbound('bad','foreign',{from_user_id:'other'}),inbound('echo','echo',{message_type:2}),inbound('wrong','wrong',{to_user_id:'other-bot'}),inbound('attachment','partial',{item_list:[{type:1,text_item:{text:'partial'}},{type:2,image_item:{}}]}),inbound('ok','task')],get_updates_buf:'next-cursor'}).mockImplementation(async(_c,cursor,signal)=>{
    expect(cursor).toBe('next-cursor')
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
  })
  const send=vi.spyOn(api,'send').mockResolvedValue({ret:0})
  const adapter=new WeixinAdapter(credential,store,async m=>{messages.push(m)},()=>{},api);cleanup.push(()=>adapter.stop())
  await adapter.start();await expect.poll(()=>store.state.channelCursor).toBe('next-cursor')
  expect(messages.map(m=>m.text)).toEqual(['task'])
  expect(send).toHaveBeenCalledWith(credential,credential.ownerUserId,'reply-context',expect.stringContaining('目前支持文字'),expect.any(AbortSignal))
  send.mockClear();await messages[0]!.send('x'.repeat(4000))
  expect(send.mock.calls).toHaveLength(3)
  expect(send.mock.calls.every(c=>c[3].length<=1800)).toBe(true)
  await adapter.stop();expect(adapter.state.phase).toBe('stopped')
})
it('routes reply and proactive images natively while preserving cancellation and explicit voice fallback',async()=>{
  const api=new WeixinApi(),messages:ChannelMessage[]=[],state:RouteState={seen:[]}
  vi.spyOn(api,'updates').mockResolvedValueOnce({msgs:[inbound('image-request','task')]}).mockImplementation(async(_c,_cursor,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})))
  const nativeImage=vi.spyOn(api,'image').mockResolvedValue(undefined),file=vi.spyOn(api,'file').mockResolvedValue(undefined)
  const adapter=new WeixinAdapter(credential,{state,save:async()=>{}},async m=>{messages.push(m)},()=>{},api)
  cleanup.push(()=>adapter.stop());await adapter.start();await expect.poll(()=>messages.length).toBe(1)
  const image={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'}
  for (const message of [messages[0]!,await adapter.scheduledMessage('scheduled:image','job')]) {
    expect(message.nativeVoice).toBe(false)
    const cancellation=new AbortController()
    await message.sendImage!(image,cancellation.signal)
    expect(nativeImage).toHaveBeenLastCalledWith(credential,credential.ownerUserId,'reply-context',image,expect.any(AbortSignal))
    const signal=nativeImage.mock.calls.at(-1)![4]
    cancellation.abort();expect(signal.aborted).toBe(true)
    await message.sendFile(image)
    await expect(message.sendVoice(image)).rejects.toThrow('use file delivery')
  }
  expect(nativeImage).toHaveBeenCalledTimes(2);expect(file).toHaveBeenCalledTimes(2)
  nativeImage.mockRejectedValueOnce(new WeixinError('upload','ambiguous delivery'))
  await expect(messages[0]!.sendImage!(image)).rejects.toThrow('ambiguous delivery')
  expect(nativeImage).toHaveBeenCalledTimes(3);expect(file).toHaveBeenCalledTimes(2)
})
it('marks expired credentials failed instead of endlessly retrying',async()=>{
  const api=new WeixinApi();vi.spyOn(api,'updates').mockRejectedValue(new WeixinError('auth','expired'))
  const adapter=new WeixinAdapter(credential,{state:{seen:[]},save:async()=>{}},async()=>{},()=>{},api)
  cleanup.push(()=>adapter.stop());await adapter.start()
  await expect.poll(()=>adapter.state.phase).toBe('failed')
  expect(api.updates).toHaveBeenCalledTimes(1)
})

it('preserves large numeric iLink message IDs without rounding',async()=>{
  const api=new WeixinApi((async()=>new Response('{"ret":0,"msgs":[{"message_id":9007199254740993123}]}')) as typeof fetch)
  const response=await api.updates(credential,'',new AbortController().signal)
  expect((response.msgs as Array<{message_id:string}>)[0]!.message_id).toBe('9007199254740993123')
})

it('stops promptly while agent admission is still pending',async()=>{
  const api=new WeixinApi();vi.spyOn(api,'updates').mockResolvedValue({msgs:[inbound('id','task')]})
  let release!:()=>void
  const receive=vi.fn(()=>new Promise<void>(r=>{release=r}))
  const adapter=new WeixinAdapter(credential,{state:{seen:[]},save:async()=>{}},receive,()=>{},api)
  cleanup.push(async()=>{release?.();await adapter.stop()})
  await adapter.start();await expect.poll(()=>receive.mock.calls.length).toBe(1)
  await adapter.stop();expect(adapter.state.phase).toBe('stopped');release()
})

it.each([
  {name:'result.txt',mimeType:'text/plain'},
  {name:'result.png',mimeType:'image/png'},
])('uploads $mimeType as an encrypted file attachment only to the pinned CDN',async media=>{
  const calls:Array<{url:string;init:RequestInit}>=[]
  const api=new WeixinApi((async(url,init)=>{
    calls.push({url:String(url),init:init!})
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'upload-token'})
    if (String(url).includes('/c2c/upload')) return new Response('',{headers:{'x-encrypted-param':'download-token'}})
    return Response.json({ret:0})
  }) as typeof fetch)
  await api.file(credential,credential.ownerUserId,'ctx',{bytes:Buffer.from('hello'),...media},new AbortController().signal)
  expect(calls).toHaveLength(3)
  expect(calls[1]!.url).toMatch(/^https:\/\/novac2c.cdn.weixin.qq.com\/c2c\/upload/)
  expect(calls[1]!.init.redirect).toBe('error')
  expect(Buffer.from(calls[1]!.init.body as Uint8Array).toString()).not.toBe('hello')
  expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({media_type:3,to_user_id:credential.ownerUserId,rawsize:5})
  expect(JSON.parse(String(calls[2]!.init.body)).msg).toMatchObject({context_token:'ctx',item_list:[{type:4,file_item:{file_name:media.name,len:'5',media:{encrypt_query_param:'download-token'}}}]})
  const malicious=new WeixinApi((async()=>Response.json({upload_full_url:'https://attacker.test/upload'})) as typeof fetch)
  await expect(malicious.file(credential,credential.ownerUserId,'ctx',{bytes:Buffer.from('hello'),name:'result.txt',mimeType:'text/plain'},new AbortController().signal)).rejects.toMatchObject({code:'url'})
})

// Wire fixture verified from Tencent's published @tencent-weixin/openclaw-weixin
// 2.4.10: src/cdn/upload.ts, src/api/types.ts, src/messaging/send.ts.
it('sends native image_type2 with media_type1, base64 hex AES key and ciphertext mid_size',async()=>{
  const calls:Array<{url:string;init:RequestInit}>=[],bytes=Buffer.from('a'.repeat(16))
  const api=new WeixinApi((async(url,init)=>{
    calls.push({url:String(url),init:init!})
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'upload-token'})
    if (String(url).includes('/c2c/upload')) return new Response('',{headers:{'x-encrypted-param':'download-token'}})
    return Response.json({ret:0})
  }) as typeof fetch)
  await api.image(credential,credential.ownerUserId,'ctx',{bytes,name:'result.png',mimeType:'image/png'},new AbortController().signal)
  expect(calls).toHaveLength(3)
  const upload=JSON.parse(String(calls[0]!.init.body)),ciphertext=Buffer.from(calls[1]!.init.body as Uint8Array)
  expect(upload).toMatchObject({media_type:1,to_user_id:credential.ownerUserId,rawsize:16,filesize:32,no_need_thumb:true,rawfilemd5:createHash('md5').update(bytes).digest('hex')})
  expect(upload.aeskey).toMatch(/^[0-9a-f]{32}$/)
  const decipher=createDecipheriv('aes-128-ecb',Buffer.from(upload.aeskey,'hex'),null)
  expect(Buffer.concat([decipher.update(ciphertext),decipher.final()])).toEqual(bytes)
  expect(calls[1]!.init).toMatchObject({method:'POST',redirect:'error',headers:{'content-type':'application/octet-stream'}})
  expect(calls[1]!.init.headers).not.toHaveProperty('Authorization')
  expect(JSON.parse(String(calls[2]!.init.body)).msg).toMatchObject({to_user_id:credential.ownerUserId,context_token:'ctx',message_type:2,message_state:2,item_list:[{type:2,image_item:{media:{encrypt_query_param:'download-token',aes_key:Buffer.from(upload.aeskey).toString('base64'),encrypt_type:1},mid_size:32}}]})
  expect(JSON.parse(String(calls[2]!.init.body)).msg.item_list[0]).not.toHaveProperty('file_item')
})

it.each(['image','file'] as const)('bounds %s upload bytes and rejects missing or invalid upload locations safely',async method=>{
  const fetcher=vi.fn(async()=>Response.json({ret:0})),api=new WeixinApi(fetcher as typeof fetch)
  const media={bytes:Buffer.alloc(DEFAULT_MAX_OUTBOUND_MEDIA_BYTES+1),name:'large.png',mimeType:'image/png'}
  await expect(api[method](credential,credential.ownerUserId,'ctx',media,new AbortController().signal)).rejects.toMatchObject({code:'size'})
  expect(fetcher).not.toHaveBeenCalled()
  media.bytes=Buffer.from('image')
  await expect(api[method](credential,credential.ownerUserId,'ctx',media,new AbortController().signal)).rejects.toMatchObject({code:'upload',message:'微信文件上传失败。'})
  expect(fetcher).toHaveBeenCalledTimes(1)
  for (const url of ['private-invalid-url','https://attacker.test/c2c/upload','https://novac2c.cdn.weixin.qq.com/other','https://user:private@novac2c.cdn.weixin.qq.com/c2c/upload']) {
    const bad=vi.fn(async()=>Response.json({upload_full_url:url}))
    await expect(new WeixinApi(bad as typeof fetch)[method](credential,credential.ownerUserId,'ctx',media,new AbortController().signal)).rejects.toMatchObject({code:'url',message:'微信上传地址无效。'})
    expect(bad).toHaveBeenCalledTimes(1)
  }
})

it.each(['image','file'] as const)('preserves cancellation after %s CDN upload and never retries rejected sends',async method=>{
  const media={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'},controller=new AbortController()
  const cancelled=vi.fn(async(url:unknown)=>{
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'private-query'})
    controller.abort();return new Response('',{headers:{'x-encrypted-param':'download-token'}})
  })
  await expect(new WeixinApi(cancelled as typeof fetch)[method](credential,credential.ownerUserId,'ctx',media,controller.signal)).rejects.toThrow()
  expect(cancelled).toHaveBeenCalledTimes(2)
  const rejected=vi.fn(async(url:unknown)=>{
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'private-query'})
    if (String(url).includes('/c2c/upload')) return new Response('',{headers:{'x-encrypted-param':'download-token'}})
    return Response.json({ret:9,errmsg:'private credential and context'})
  })
  await expect(new WeixinApi(rejected as typeof fetch)[method](credential,credential.ownerUserId,'ctx',media,new AbortController().signal)).rejects.toMatchObject({code:'rejected',message:'微信拒绝了请求。'})
  expect(rejected).toHaveBeenCalledTimes(3)
})

it.each(['image','file'] as const)('checks cancellation between %s upload phases and never retries ambiguous CDN failures',async method=>{
  const media={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'}
  const controller=new AbortController(),fetcher=vi.fn(async()=>{controller.abort();return Response.json({ret:0,upload_param:'private-query'})})
  const api=new WeixinApi(fetcher as typeof fetch)
  await expect(api[method](credential,credential.ownerUserId,'ctx',media,controller.signal)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(api[method](credential,credential.ownerUserId,'ctx',media,controller.signal)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  const ambiguous=vi.fn(async(url:unknown)=>{
    if (String(url).includes('getuploadurl')) return Response.json({ret:0,upload_param:'private-query'})
    throw new Error('private-query token or ambiguous upload')
  })
  await expect(new WeixinApi(ambiguous as typeof fetch)[method](credential,credential.ownerUserId,'ctx',media,new AbortController().signal)).rejects.toMatchObject({code:'upload',message:'微信文件上传失败。'})
  expect(ambiguous).toHaveBeenCalledTimes(2)
})
it('bounds emoji replies without breaking grapheme clusters',()=>{
  const family='👨‍👩‍👧‍👦',text=family.repeat(400),parts=splitWeixinText(text)
  expect(parts.every(part=>part.length<=1800 && part.length%family.length===0)).toBe(true)
  expect(parts.join('')).toBe(text)
})

it('uses only the bound owner and persisted private context for proactive replies',async()=>{
  const api=new WeixinApi(),state:RouteState={seen:[],weixinContext:'persisted-private-context'}
  vi.spyOn(api,'updates').mockResolvedValue({msgs:[],get_updates_buf:'next'})
  const send=vi.spyOn(api,'send').mockResolvedValue({ret:0})
  const adapter=new WeixinAdapter(credential,{state,save:async()=>{}},async()=>{},()=>{},api);cleanup.push(()=>adapter.stop())
  await adapter.start();await expect.poll(()=>adapter.state.phase).toBe('listening')
  const scheduled=await adapter.scheduledMessage('cron:daily:1','check')
  expect(JSON.stringify(scheduled)).not.toContain('persisted-private-context')
  await scheduled.send('result')
  expect(send).toHaveBeenCalledWith(credential,credential.ownerUserId,'persisted-private-context','result',expect.any(AbortSignal))
  delete state.weixinContext
  await expect(adapter.scheduledMessage('cron:daily:2','check')).rejects.toThrow()
  await adapter.stop();await expect(adapter.scheduledMessage('cron:daily:3','check')).rejects.toThrow()
})

it('resumes an opaque migrated cursor across restarts without executing legacy or duplicate inputs',async()=>{
  let persisted:RouteState=legacyCheckpoint({seen:['old-message'],channelCursor:'opaque+/=0001'},'weixin')
  const oldIds=new Set(persisted.seen),submitted:string[]=[],sent:string[]=[]
  let receipts:BindingState={receipts:[]}
  const makeBridge=()=>new ChannelBridge({
    open:async()=>({id:'channels-synthetic',submit:(id:string)=>{submitted.push(id);return {admitted:Promise.resolve(),result:Promise.resolve({text:'synthetic result',reason:'completed'})}},cancel:()=>{},close:async()=>{}} satisfies NativeSession),
    inspect:async()=>undefined,
  },{read:()=>structuredClone(receipts),write:async state=>{receipts=structuredClone(state)}})
  const run=async(cursor:string,next:string,ids:string[])=>{
    const unexpectedFetch=vi.fn(async()=>{throw new Error('Offline test forbids network')})
    const state=structuredClone(persisted),store={state,save:async()=>{persisted=structuredClone(state)}},api=new WeixinApi(unexpectedFetch as typeof fetch),bridge=makeBridge()
    let release!:(value:Record<string,unknown>)=>void
    vi.spyOn(api,'updates').mockImplementationOnce(async(_c,received)=>{expect(received).toBe(cursor);return new Promise(resolve=>{release=resolve})}).mockImplementation(async(_c,received,signal)=>{
      expect(received).toBe(next);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))
    })
    vi.spyOn(api,'send').mockImplementation(async(_c,user,context,text)=>{expect(user).toBe(credential.ownerUserId);expect(context).toBe('reply-context');sent.push(text);return {ret:0}})
    vi.spyOn(api,'typing').mockResolvedValue(undefined)
    const adapter=new WeixinAdapter(credential,store,async message=>{if(!wasLegacyMessage(oldIds,message.id))await bridge.receive(message)},()=>{},api)
    cleanup.push(async()=>{await adapter.stop();await bridge.close()})
    await adapter.start();await vi.waitFor(()=>expect(release).toBeTypeOf('function'))
    if(!state.weixinContext)await expect(adapter.scheduledMessage('no-context','synthetic')).rejects.toThrow('active conversation')
    release({msgs:[inbound('foreign','foreign',{from_user_id:'other'}),...ids.map(id=>inbound(id,'synthetic task'))],get_updates_buf:next})
    await vi.waitFor(()=>expect(persisted.channelCursor).toBe(next));await bridge.drain();await adapter.stop();await bridge.close()
    expect(unexpectedFetch).not.toHaveBeenCalled()
  }
  expect(persisted.weixinContext).toBeUndefined()
  await run('opaque+/=0001','opaque+/=0002',['old-message','new-message'])
  const firstSubmission=submitted[0];expect(submitted).toHaveLength(1)
  await run('opaque+/=0002','opaque+/=0003',['old-message','new-message','newer-message'])
  expect(submitted).toHaveLength(2);expect(submitted[1]).not.toBe(firstSubmission)
  expect(sent).toEqual(['synthetic result','synthetic result'])
  expect(receipts.receipts).toHaveLength(2)
})

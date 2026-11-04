import { expect, it, vi } from 'vitest'
import { IMessageAdapter } from '../src/channels/imessage.js'
import type { ChannelMessage } from '../src/channels/types.js'
import type { SpectrumConnectionFactory } from '../src/spectrum-runtime.js'

it('adds inbound and proactive image attachment delivery without changing native iMessage voice',async()=>{
  const file=vi.fn(async()=>{}),voice=vi.fn(async()=>{})
  const message:ChannelMessage={id:'inbound',text:'task',send:async()=>{},sendFile:file,sendVoice:voice,responding:callback=>callback()}
  let end!:()=>void
  const stopped=new Promise<void>(resolve=>{end=resolve})
  const factory:SpectrumConnectionFactory=async()=>({
    messages:(async function*(){yield message;await stopped})(),
    scheduledMessage:async(id,text)=>({...message,id,text}),stop:async()=>{end()},
  })
  const received:ChannelMessage[]=[]
  const adapter=new IMessageAdapter({projectId:'project',projectSecret:'synthetic',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'},async m=>{received.push(m)},()=>{},factory)
  try {
    await adapter.start();await expect.poll(()=>received.length).toBe(1)
    const image={bytes:Buffer.from('image'),name:'result.png',mimeType:'image/png'}
    const audio={bytes:Buffer.from('audio'),name:'voice.m4a',mimeType:'audio/mp4'}
    for (const outbound of [received[0]!,await adapter.scheduledMessage('proactive','job')]) {
      expect(outbound.nativeVoice).not.toBe(false)
      const cancellation=new AbortController()
      await outbound.sendImage!(image,cancellation.signal)
      expect(file).toHaveBeenLastCalledWith(image,cancellation.signal)
      await outbound.sendVoice(audio,cancellation.signal)
      expect(voice).toHaveBeenLastCalledWith(audio,cancellation.signal)
      cancellation.abort()
      await expect(outbound.sendImage!(image,cancellation.signal)).rejects.toThrow()
      await expect(outbound.sendFile(image,cancellation.signal)).rejects.toThrow()
      await expect(outbound.sendVoice(audio,cancellation.signal)).rejects.toThrow()
    }
    expect(file).toHaveBeenCalledTimes(2);expect(voice).toHaveBeenCalledTimes(2)
  } finally {await adapter.stop()}
})

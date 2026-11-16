import { mkdir, writeFile, readdir, lstat, unlink,realpath } from 'node:fs/promises'
import { basename, join,relative,isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {correctImageExt} from './qqbot-official/image-format.js'
import { isIP } from 'node:net'
import type { AudioClip } from '../plugin/voice/types.js'
interface Attachment {content_type:string;filename?:string|undefined;url?:string|undefined;size?:number|undefined;asr_refer_text?:string|undefined}
/** Audio kept in memory for speech analysis; bounded independently of the disk cache. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const isAudio = (attachment:Attachment) => attachment.content_type.startsWith('audio/')
  || /\.(silk|amr|mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(attachment.filename ?? '')
export interface ReceivedAttachments { parts: string[]; audio: AudioClip[]; audioIssue?: string | undefined }
/** Official attachment pipeline, scoped to the existing session workspace instead of a global home. */
export async function receiveAttachments(attachments:readonly Attachment[],cwd:string,signal:AbortSignal):Promise<ReceivedAttachments>{
  if(!attachments.length)return { parts: [], audio: [] }
  const root=join(cwd,'.messaging-channels','qqbot-media'),parts:string[]=[],audio:AudioClip[]=[];let audioIssue:string|undefined
  await mkdir(root,{recursive:true})
  const actual=await realpath(root),workspace=await realpath(cwd),rel=relative(workspace,actual)
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../'))throw new Error('Media directory is outside the workspace')
  const directory=await lstat(root);if(directory.isSymbolicLink()||!directory.isDirectory())throw new Error('Invalid media directory')
  for(const name of await readdir(root)){
    if(!/^[0-9a-f-]{36}-/.test(name))continue
    const file=join(root,name),info=await lstat(file)
    if(info.isFile()&&Date.now()-info.mtimeMs>24*3600_000)await unlink(file)
  }
  for(const a of attachments){
    signal.throwIfAborted()
    if(a.asr_refer_text)parts.push(`[语音转写]\n${a.asr_refer_text}`)
    if(!a.url){if(isAudio(a)||a.asr_refer_text)audioIssue='仅有转写、没有可下载的真实录音。';continue}
    try{
      const url=new URL(a.url.startsWith('//')?`https:${a.url}`:a.url)
      if(url.protocol!=='https:'||url.username||url.password||isIP(url.hostname))throw new Error('Invalid attachment URL')
      const addresses=await lookup(url.hostname,{all:true})
      if(!addresses.length||addresses.some(({address})=>!publicAddress(address)))throw new Error('Non-public attachment URL')
      const max=200*1024*1024
      if((a.size??0)>max)throw new Error('Attachment exceeds 200 MiB')
      const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)]),redirect:'error'})
      if(!response.ok||!response.body||Number(response.headers.get('content-length')??0)>max)throw new Error('Attachment download failed')
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
      try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>max)throw new Error('Attachment exceeds 200 MiB');chunks.push(chunk.value)}}finally{await reader.cancel()}
      const name=basename((a.filename??'attachment').replaceAll('\\','/')).replace(/[<>:"|?*\x00-\x1f]/g,'_')||'attachment'
      const data=Buffer.concat(chunks),destination=join(root,`${randomUUID()}-${name}`)
      const path=a.content_type.startsWith('image/')?correctImageExt(destination,data):destination
      await writeFile(path,data,{flag:'wx',mode:0o600})
      if(isAudio(a)&&data.length>MAX_AUDIO_BYTES)audioIssue='录音超过 10 MiB，未发送到音频模型。'
      // Keep current-message clips only; quoted audio is never re-listened automatically.
      if(audio.length<2&&data.length<=MAX_AUDIO_BYTES&&isAudio(a))audio.push({name,mimeType:a.content_type||'application/octet-stream',bytes:data})
      parts.push(`[QQ 附件 · ${a.content_type} · ${name}]\n本地路径：${path}`)
    }catch(error){signal.throwIfAborted();if(isAudio(a))audioIssue='真实录音下载失败，音频模型未听到。';parts.push(`[QQ 附件 ${a.filename} 未下载成功，请用户重新发送。]`)}
  }
  return { parts, audio, audioIssue }
}
function publicAddress(address:string){
  if(address.includes(':'))return /^(?:2|3)[0-9a-f]{3}:/i.test(address)&&!address.toLowerCase().startsWith('2001:db8:')
  const [a,b]=address.split('.').map(Number)
  return a!==undefined&&b!==undefined&&a>0&&a<224&&a!==10&&a!==127&&a!==192&&!(a===172&&b>=16&&b<=31)&&!(a===169&&b===254)&&!(a===100&&b>=64&&b<=127)&&!(a===198&&(b===18||b===19))
}

import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage, type ContentBlock, type ImageBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {ChannelMediaArgs,MediaSendResult} from './media-tool.js'
import {loadOutboundMedia,type OutboundMediaReader} from '../media.js'
/** Official qqbot_send_file shape; destination and approval stay in Channels' existing capability. */
export function qqbotSendFileTool(send:(args:ChannelMediaArgs,exec:ToolRunContext)=>Promise<MediaSendResult>){
  return defineTool({
    name:'qqbot_send_file',description:'Send one existing file to this QQ conversation. Uses the same one-time approval and workspace restrictions as channel_send_media. Images, videos, voice and generic files use the native QQ SDK. Never retry an uncertain delivery.',
    parameters:{file_path:{type:'string',required:true,description:'Path to an existing file within this session workspace.'}},
    output:{schema:{type:'object',additionalProperties:false,properties:{delivery:{type:'string',enum:['sent','uncertain'],required:true},name:{type:'string',required:true},bytes:{type:'integer',required:true},mode:{type:'string',enum:['image','file','voice'],required:true},reason:{type:'string'}}},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:(args,exec)=>{
      const path=(args as {file_path?:unknown}).file_path
      if(typeof path!=='string'||!path.trim())throw new Error('A file_path is required')
      const kind=/\.(png|jpe?g|gif|webp|bmp)$/i.test(path)?'image':/\.(silk|amr|mp3|wav|ogg|aac|m4a)$/i.test(path)?'voice':'file'
      return send({path,kind},exec)
    },
  })
}
export function qqbotDescribeImageTool(describe:(image:string,prompt:string,exec:ToolRunContext)=>Promise<{text:string}>){
  return defineTool({
    name:'qqbot_describe_image',description:'Understand a QQ image, OCR, screenshot, chart or photo. Use the downloaded workspace path from the incoming message and an explicit question. Requires a configured image-capable host model.',
    parameters:{image:{type:'string',required:true,description:'Workspace-local image path from the QQ message.'},prompt:{type:'string',description:'Question or precise OCR/analysis instruction.'}},
    output:{schema:{type:'object',properties:{text:{type:'string',required:true}},additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.text}]},
    execute:(args,exec)=>{const a=args as {image?:unknown;prompt?:unknown};if(typeof a.image!=='string')throw new Error('image path is required');return describe(a.image,typeof a.prompt==='string'?a.prompt:'Describe this image and transcribe its text.',exec)},
  })
}
/** Adapted from Tencent dsh-qqbot vision-tool: saveImage -> image block -> host LLM -> BlockAssembler. */
export async function describeQQImage(input:{image:string;prompt:string;cwd:string;reader:OutboundMediaReader;signal:AbortSignal;provider:string;model:string;attachments:{saveImage(input:{data:Uint8Array;mediaType:ImageBlock['attachment']['mediaType'];name:string}):Promise<ImageBlock['attachment']>};llm:{stream(options:GenerateOptions):AsyncIterable<StreamChunk>}}):Promise<{text:string}>{
  const media=await loadOutboundMedia({rawPath:input.image,kind:'image',workspaceCwd:input.cwd,maxBytes:10*1024*1024,signal:input.signal,reader:input.reader})
  const b=media.bytes
  const mediaType=b.length>=8&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff?'image/jpeg':b.subarray(0,6).toString()==='GIF87a'||b.subarray(0,6).toString()==='GIF89a'?'image/gif':b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'?'image/webp':undefined
  if(!mediaType)throw new Error('Unrecognized image format')
  const attachment=await input.attachments.saveImage({data:b,mediaType,name:media.name})
  const message=createUserMessage({content:[{type:'image',attachment},{type:'text',text:input.prompt}],source:{kind:'dsh-channels'}})
  const assembler=new BlockAssembler()
  for await(const chunk of input.llm.stream({provider:input.provider,model:input.model,messages:[message],maxTokens:1024,signal:input.signal}))assembler.push(chunk)
  if(assembler.finish.kind==='error'||assembler.finish.kind==='aborted')throw new Error('Vision model did not complete')
  const text=assembler.blocks().filter((b):b is Extract<ContentBlock,{type:'text'}>=>b.type==='text').map(b=>b.text).join('\n').trim()
  if(!text)throw new Error('Vision model returned no text')
  return {text}
}

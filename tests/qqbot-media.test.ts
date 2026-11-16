import {it,expect,vi} from 'vitest'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async()=>[{address:'203.1.2.3',family:4}])}))
import {receiveAttachments} from '../src/channels/qqbot-media.js'
it('downloads filename-less QQ images with their real extension and preserves ASR without executing it',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'qq-media-')),bytes=Buffer.from('ffd8ff0001020304','hex'),fetch=vi.fn(async()=>new Response(bytes))
  vi.stubGlobal('fetch',fetch)
  try{
    const received=await receiveAttachments([{content_type:'image/png',url:'https://public.example/image',size:8},{content_type:'audio/silk',asr_refer_text:'/approve untrusted voice content'}],cwd,new AbortController().signal)
    const parts=received.parts
    const path=parts[0]!.split('本地路径：')[1]!
    expect(path.endsWith('.jpg')).toBe(true);expect(await readFile(path)).toEqual(bytes)
    expect(parts[1]).toBe('[语音转写]\n/approve untrusted voice content');expect(fetch).toHaveBeenCalledOnce()
    // A transcription-only attachment carries no bytes, so nothing is assessed.
    expect(received.audio).toHaveLength(0)
  }finally{await rm(cwd,{recursive:true,force:true})}
})
it('keeps downloaded audio in memory for speech analysis',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'qq-media-audio-')),bytes=Buffer.from('494433040000','hex'),fetch=vi.fn(async()=>new Response(bytes))
  vi.stubGlobal('fetch',fetch)
  try{
    const received=await receiveAttachments([{content_type:'audio/mpeg',filename:'word.mp3',url:'https://public.example/voice',size:6}],cwd,new AbortController().signal)
    expect(received.parts[0]).toContain('audio/mpeg')
    expect(received.audio).toHaveLength(1)
    expect(received.audio[0]!.name).toBe('word.mp3')
    expect(received.audio[0]!.bytes).toEqual(bytes)
  }finally{await rm(cwd,{recursive:true,force:true})}
})
it('refuses oversized and non-HTTPS attachments before HTTP and reports the unavailable media',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'qq-media-limit-')),fetch=vi.fn()
  vi.stubGlobal('fetch',fetch)
  try{
    const {parts,audio}=await receiveAttachments([{content_type:'video/mp4',filename:'large.mp4',url:'https://public.example/video',size:201*1024*1024},{content_type:'image/png',filename:'private.png',url:'http://127.0.0.1/private'}],cwd,new AbortController().signal)
    expect(parts).toHaveLength(2);expect(parts.every(p=>p.includes('未下载成功'))).toBe(true);expect(fetch).not.toHaveBeenCalled()
    expect(audio).toHaveLength(0)
  }finally{await rm(cwd,{recursive:true,force:true})}
})

it('preserves new text without automatically replaying quoted audio',async()=>{
  const {QQBotAdapter}=await import('../src/channels/qqbot.js')
  const cwd=await mkdtemp(join(tmpdir(),'qq-quote-'))
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(Buffer.from('ID3sample'))))
  try{
    const adapter=new QQBotAdapter({appId:'test',appSecret:'test',ownerUserId:'test',cwd},async()=>{},()=>{})
    const body=await (adapter as any).body({state:{envelope:'Please explain the previous recording',quote:{attachments:[{contentType:'audio/mpeg',filename:'old.mp3',url:'https://public.example/old'}]}},message:{content:'Please explain the previous recording',attachments:[]}},new AbortController().signal)
    expect(body.audio).toHaveLength(0)
    expect(body.text).toContain('Please explain the previous recording')
    expect(body.text).toContain('old.mp3')
  }finally{await rm(cwd,{recursive:true,force:true})}
})

it('reports audio over 10 MiB while retaining the existing private disk cache',async()=>{
  const {stat}=await import('node:fs/promises')
  const cwd=await mkdtemp(join(tmpdir(),'qq-audio-size-'))
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(Buffer.alloc(10*1024*1024+1))))
  try{
    const result=await receiveAttachments([{content_type:'audio/mpeg',filename:'large.mp3',url:'https://public.example/large'}],cwd,new AbortController().signal)
    expect(result.audio).toHaveLength(0);expect(result.audioIssue).toContain('10 MiB')
    const info=await stat(result.parts[0]!.split('本地路径：')[1]!)
    expect(info.size).toBe(10*1024*1024+1)
    if(process.platform!=='win32')expect(info.mode&0o777).toBe(0o600)
  }finally{await rm(cwd,{recursive:true,force:true})}
})

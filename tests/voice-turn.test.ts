import {it,expect,vi} from 'vitest'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChannelBridge,type BindingState} from '../src/plugin/bridge.js'
import {createVoiceCoach} from '../src/plugin/voice/index.js'
import type {VoiceHandler} from '../src/plugin/voice/tool.js'
import type {ReplyModeHandler,ReplyMode} from '../src/plugin/voice/output-tool.js'
import type {VoiceSettings} from '../src/plugin/voice/types.js'
const mp3=Buffer.from('494433040000fffb9000','hex')
const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEfmt '),Buffer.alloc(64)])
const settings=(patch:Partial<VoiceSettings>={}):VoiceSettings=>({enabled:true,replyMode:'text',credentialRef:'KEY',baseURL:'https://audio.example/v1',model:'gpt-audio',speechModel:'gpt-4o-mini-tts',voice:'alloy',instructions:'',...patch})
const api=(options:{listenStatus?:number;speechStatus?:number;empty?:boolean;onSpeech?:(text:string)=>Promise<void>}={})=>vi.fn(async(input:unknown,init?:RequestInit)=>{
  if(String(input).endsWith('/chat/completions'))return new Response(JSON.stringify(options.listenStatus?{error:{message:'audio unavailable'}}:{choices:[{message:{content:options.empty?'':'User asks to save a note. Audible stress is on the first syllable.'}}]}),{status:options.listenStatus??200})
  if(String(input).endsWith('/audio/speech')){const text=JSON.parse(String(init?.body)).input;await options.onSpeech?.(text);return options.speechStatus?new Response(JSON.stringify({error:{message:'speech unavailable'}}),{status:options.speechStatus}):new Response(mp3)}
  throw new Error('unexpected endpoint')
})
function harness(options:{audio?:boolean;mode?:ReplyMode;defaultMode?:ReplyMode;repeat?:boolean;work?:(understanding:string)=>Promise<string>;finalText?:string;terminalText?:string;key?:boolean;enabled?:boolean}={}){
  let state:BindingState={receipts:[]};const sent:Array<[string,string]>=[],history:unknown[]=[]
  const controller=new AbortController()
  const submit=vi.fn((id:string,_text:string,_p:unknown,_i:unknown,_media:unknown,_stream:unknown,_notice:unknown,listen?:VoiceHandler,select?:ReplyModeHandler)=>({admitted:Promise.resolve(),result:Promise.resolve().then(async()=>{
    try{
      if(options.mode)select?.(options.mode)
      let understanding='text request'
      if(listen){const request={inputId:id,sessionId:'session',turn:1,callId:'listen',signal:controller.signal,current:()=>!controller.signal.aborted,context:'Project instruction. Prior conversation. Current user text.'};const replies=await Promise.all(options.repeat?[listen(request),listen({...request,callId:'listen-again'})]:[listen(request)]);history.push(...replies.map(JSON.parse));understanding=JSON.parse(replies[0]!).text}
      const text=options.work?await options.work(understanding):options.finalText??'Here is the final answer.'
      history.push({assistant:text});controller.abort() // Native input scope ends before final synthesis.
      return {text,...(options.terminalText===undefined?{}:{finalText:options.terminalText}),reason:'completed'}
    }catch(error){return {text:`Operation failed: ${String(error)}`,reason:'completed'}}
  })}))
  const recordVoiceReply=vi.fn(async(id:string,value:unknown)=>{history.push({inputId:id,voiceReceipt:value})})
  const session={id:'session',isLive:()=>true,submit,cancel:()=>controller.abort(),close:async()=>{},recordVoiceReply}
  const bridge=new ChannelBridge({open:async()=>session,inspect:async()=>undefined},{read:()=>state,write:async next=>{state=next}},undefined,()=>{},createVoiceCoach(settings({enabled:options.enabled??true,replyMode:options.defaultMode??'text'}),options.key===false?undefined:'synthetic-key'))
  const message={id:'qq:1',commandChannel:'qqbot',text:'Current user request (ASR is auxiliary only)',audio:options.audio===false?undefined:[{name:'voice.wav',mimeType:'audio/wav',bytes:wav}],responding:<T>(fn:()=>Promise<T>)=>fn(),send:async(text:string)=>{sent.push(['text',text])},sendVoice:async()=>{sent.push(['voice','mp3'])},sendFile:async()=>{sent.push(['file','mp3'])}}
  return {bridge,message,sent,history,submit,recordVoiceReply,state:()=>state}
}
const run=async(f:ReturnType<typeof harness>,message=f.message)=>{try{await f.bridge.receive(message as never);await f.bridge.drain()}finally{await f.bridge.close()}}
it.each([[false,'text'],[false,'voice'],[true,'text'],[true,'voice']] as const)('independently routes audio input=%s to explicitly selected %s output',async(audio,mode)=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({audio,mode});await run(f)
  expect(f.sent.map(([kind])=>kind)).toEqual([mode])
  expect(fetch.mock.calls.filter(([url])=>String(url).endsWith('/chat/completions'))).toHaveLength(audio?1:0)
  expect(fetch.mock.calls.filter(([url])=>String(url).endsWith('/audio/speech'))).toHaveLength(mode==='voice'?1:0)
  if(mode==='voice'){expect(f.history).toContainEqual({assistant:'Here is the final answer.'});expect(f.recordVoiceReply).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({text:'Here is the final answer.',delivery:expect.objectContaining({delivery:'sent'})}))}
})
it.each([['voice','text'],['text','voice']] as const)('explicit %s overrides configured %s output default',async(mode,defaultMode)=>{vi.stubGlobal('fetch',api());const f=harness({audio:false,mode,defaultMode});await run(f);expect(f.sent.map(([kind])=>kind)).toEqual([mode])})
it('defaults to existing text output without a selection',async()=>{vi.stubGlobal('fetch',api());const f=harness({audio:false});await run(f);expect(f.sent.map(([kind])=>kind)).toEqual(['text'])})
it('sends original bytes plus selected project/history context; never substitutes ASR',async()=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({mode:'text'});await run(f)
  const body=JSON.parse(String(fetch.mock.calls[0]![1]!.body));expect(body.modalities).toEqual(['text']);expect(body.audio).toBeUndefined()
  expect(body.messages.at(-1).content[0].text).toContain('Prior conversation')
  expect(Buffer.from(body.messages.at(-1).content[1].input_audio.data,'base64')).toEqual(wav)
  expect(f.history[0]).toMatchObject({heardBy:'audio-model',actionsExecuted:false,text:expect.stringContaining('Audible stress')})
})
it('writes a real synthetic note before synthesizing and sends exactly one final voice',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'voice-note-'));const path=join(cwd,'note.txt'),order:string[]=[]
  vi.stubGlobal('fetch',api({onSpeech:async text=>{expect(await readFile(path,'utf8')).toBe('synthetic note');expect(text).toBe('The note was saved.');order.push('synthesize')}}))
  const f=harness({mode:'voice',work:async understanding=>{expect(understanding).toContain('save a note');expect(f.sent).toHaveLength(0);await writeFile(path,'synthetic note');order.push('write');return 'The note was saved.'}})
  try{await run(f);expect(order).toEqual(['write','synthesize']);expect(f.sent.map(([kind])=>kind)).toEqual(['voice'])}finally{await rm(cwd,{recursive:true,force:true})}
})
it('speaks the actual failed-tool outcome, never a premature success',async()=>{
  vi.stubGlobal('fetch',api({onSpeech:async text=>{expect(text).toContain('WRITE_DENIED');expect(text).not.toContain('note was saved')}}))
  const f=harness({mode:'voice',work:async()=>{throw new Error('WRITE_DENIED')}});await run(f);expect(f.sent.map(([kind])=>kind)).toEqual(['voice'])
})
it('supports conversational and pronunciation-example scripts without a built-in coach',async()=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({mode:'voice',finalText:'Listen to this example: think. Now try again.'});await run(f)
  const speech=JSON.parse(String(fetch.mock.calls[1]![1]!.body));expect(speech.input).toBe('Listen to this example: think. Now try again.');expect(speech.model).toBe('gpt-4o-mini-tts')
  expect(f.sent.map(([kind])=>kind)).toEqual(['voice'])
})
it('deduplicates concurrent listening calls and inbound retries without repeating work or speech',async()=>{
  const fetch=api(),work=vi.fn(async()=> 'Done.');vi.stubGlobal('fetch',fetch);const f=harness({mode:'voice',repeat:true,work});try{await f.bridge.receive(f.message as never);await f.bridge.drain();await f.bridge.receive(f.message as never);await f.bridge.drain()}finally{await f.bridge.close()}
  expect(fetch).toHaveBeenCalledTimes(2);expect(work).toHaveBeenCalledOnce();expect(f.sent.map(([kind])=>kind)).toEqual(['voice'])
})
it('reports uncertain upload with text fallback, records its status and never retries',async()=>{
  vi.stubGlobal('fetch',api());const f=harness({mode:'voice'}),upload=vi.fn(async()=>{throw new Error('network lost')});await run(f,{...f.message,sendVoice:upload})
  expect(upload).toHaveBeenCalledOnce();expect(f.sent.at(-1)?.[1]).toContain('语音投递未确认');expect(f.recordVoiceReply).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({delivery:expect.objectContaining({delivery:'uncertain'})}))
})
it('uses file fallback without a duplicate text answer',async()=>{vi.stubGlobal('fetch',api());const f=harness({mode:'voice'});await run(f,{...f.message,nativeVoice:false} as never);expect(f.sent.map(([kind])=>kind)).toEqual(['file'])})
it.each([{listenStatus:400},{empty:true}])('does not synthesize after failed listening: %j',async options=>{const fetch=api(options);vi.stubGlobal('fetch',fetch);const f=harness({mode:'voice'});await run(f);expect(fetch).toHaveBeenCalledOnce();expect(f.sent[0]![0]).toBe('text');expect(f.sent[0]![1]).toContain('原声未成功听取')})
it('reports missing key and ASR-only/oversize audio without pretending to hear it',async()=>{
  for(const patch of [{key:false},{}]){const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({...patch,mode:'voice'});await run(f,patch.key===false?f.message:{...f.message,audio:[],audioIssue:'仅有ASR，没有原音'} as never);expect(fetch).not.toHaveBeenCalled();expect(f.sent[0]![0]).toBe('text');expect(f.sent[0]![1]).toContain('原声未成功听取')}
})
it('preserves text if final speech synthesis fails',async()=>{vi.stubGlobal('fetch',api({speechStatus:400}));const f=harness({mode:'voice'});await run(f);expect(f.sent).toHaveLength(1);expect(f.sent[0]![0]).toBe('text');expect(f.sent[0]![1]).toContain('Here is the final answer.');expect(f.sent[0]![1]).toContain('最终语音未确认完成')})
it.each([['cancel','/audio/speech'],['disconnect','/audio/speech'],['cancel','/chat/completions'],['disconnect','/chat/completions']] as const)('aborts %s during %s with no late voice',async(action,endpoint)=>{
  const normal=api();let signal:AbortSignal|undefined;const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{if(String(url).endsWith(endpoint)){signal=init!.signal as AbortSignal;return await new Promise<Response>((_r,reject)=>signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))}return normal(url,init)})
  vi.stubGlobal('fetch',fetch);const f=harness({mode:'voice'});try{await f.bridge.receive(f.message as never);await vi.waitFor(()=>expect(signal).toBeDefined());if(action==='cancel')await f.bridge.receive({...f.message,id:'cancel',text:'/cancel'} as never);else f.bridge.setConnected(false);await f.bridge.drain();expect(signal!.aborted).toBe(true);expect(f.sent.some(([kind])=>kind==='voice')).toBe(false)}finally{await f.bridge.close()}
})
it('normalizes a mislabeled WAV and decodes real synthetic SILK',async()=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const coach=createVoiceCoach(settings(),'key');await coach.turn({clip:{name:'wrong.mp3',mimeType:'audio/mpeg',bytes:wav},signal:new AbortController().signal});expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body)).messages.at(-1).content[0].input_audio.format).toBe('wav')
  const {encode}=await import('silk-wasm'),{decodeSilkToWav}=await import('../src/plugin/voice/silk.js');const pcm=Buffer.alloc(6400);for(let i=0;i<3200;i++)pcm.writeInt16LE(Math.round(5000*Math.sin(2*Math.PI*440*i/16000)),2*i);const encoded=await encode(pcm,16000);expect((await decodeSilkToWav(Buffer.from(encoded.data),new AbortController().signal)).ok).toBe(true)
})
it('leaves other channels and normal disabled text behavior unchanged',async()=>{const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({audio:false,mode:'voice'});await run(f,{...f.message,commandChannel:'weixin'});expect(fetch).not.toHaveBeenCalled();expect(f.sent.map(([kind])=>kind)).toEqual(['text'])})


it('does not truncate an oversized final speech script or send a partial voice',async()=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({audio:false,mode:'voice',finalText:'x'.repeat(4097)});await run(f)
  expect(fetch).not.toHaveBeenCalled();expect(f.sent[0]![0]).toBe('text');expect(f.sent[0]![1]).toContain('4096');expect(f.sent[0]![1]).toContain('x'.repeat(4097))
})

it('preserves normal disabled text conversation without either model endpoint',async()=>{
  const fetch=api();vi.stubGlobal('fetch',fetch);const f=harness({audio:false,enabled:false});await run(f);expect(fetch).not.toHaveBeenCalled();expect(f.sent.map(([kind])=>kind)).toEqual(['text'])
})


it('synthesizes only the terminal Agent answer, excluding pre-tool claims',async()=>{
  vi.stubGlobal('fetch',api({onSpeech:async text=>{expect(text).toBe('The write failed. No note was saved.')}}))
  const f=harness({mode:'voice',finalText:'I saved your note before checking. The write failed. No note was saved.',terminalText:'The write failed. No note was saved.'});await run(f);expect(f.sent.map(([kind])=>kind)).toEqual(['voice'])
})

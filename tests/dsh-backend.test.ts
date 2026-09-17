import { afterEach, expect, it, vi } from 'vitest'
import { DshBackend } from '../src/backends/dsh.js'
import type { Rpc, ObjectValue } from '../src/codex/rpc.js'
import { gatewayTools } from '../src/gateway/tools.js'
class Wire implements Rpc {
  onNotification:Rpc['onNotification']=()=>{}
  onRequest:Rpc['onRequest']=async()=>({})
  onClose=()=>{}
  close=vi.fn()
  notify=vi.fn()
  finish!:(value:ObjectValue)=>void
  request=vi.fn(async(method:string,_params:ObjectValue):Promise<ObjectValue>=>{
    if(method==='initialize')return {protocolVersion:1}
    if(method==='session/new')return {sessionId:'dsh-session'}
    if(method==='session/prompt')return new Promise(resolve=>{this.finish=resolve})
    return {}
  })
}
const backends:DshBackend[]=[]
afterEach(async()=>{await Promise.all(backends.splice(0).map(b=>b.close()))})
it('starts headless sessions, selects model and effort, maps permissions and cancellation',async()=>{
  const wire=new Wire(),backend=new DshBackend(wire);backends.push(backend)
  await backend.initialize()
  await backend.openSession({cwd:'/workspace',model:'model',effort:'high',tools:gatewayTools})
  expect(wire.request).toHaveBeenCalledWith('session/set_config_option',{sessionId:'dsh-session',configId:'reasoning_effort',value:'high'})
  const events:unknown[]=[];backend.onEvent=e=>events.push(e)
  const id=await backend.startTurn('dsh-session','hi')
  backend.onRequest=vi.fn(async()=>({decision:'accept'}))
  const answer=await wire.onRequest('session/request_permission',{sessionId:'dsh-session',toolCall:{title:'Run command',rawInput:{command:'pwd'}},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]})
  expect(answer).toEqual({outcome:{outcome:'selected',optionId:'allow'}})
  await expect(wire.onRequest('session/request_permission',{sessionId:'other'})).rejects.toThrow()
  await backend.cancel('dsh-session',id)
  expect(wire.notify).toHaveBeenCalledWith('session/cancel',{sessionId:'dsh-session'})
  wire.finish({stopReason:'cancelled'})
  await expect.poll(()=>events.at(-1)).toMatchObject({type:'completed',status:'interrupted'})
})
it('provides shared media through authenticated MCP and resumes exact sessions',async()=>{
  const wire=new Wire(),backend=new DshBackend(wire);backends.push(backend)
  await backend.openSession({cwd:'/workspace',id:'saved',tools:gatewayTools})
  const call=wire.request.mock.calls.find(c=>c[0]==='session/resume')!
  const servers=call[1].mcpServers as Array<{url:string;headers:Array<{name:string;value:string}>}>
  const server=servers[0]!
  expect((await fetch(server.url,{method:'POST',body:'{}'})).status).toBe(403)
  const headers={'Authorization':server.headers[0]!.value,'content-type':'application/json'}
  const response=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})
  expect((await response.json() as {result:{tools:unknown[]}}).result.tools).toHaveLength(3)
  const id=await backend.startTurn('saved','send')
  backend.onRequest=vi.fn(async()=>({success:true}))
  const sent=await fetch(server.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'send_imessage_file',arguments:{path:'x'}}})})
  expect(sent.status).toBe(200)
  expect(backend.onRequest).toHaveBeenCalledWith({kind:'tool',sessionId:'saved',turnId:id,payload:{tool:'send_imessage_file',arguments:{path:'x'}}})
  wire.finish({stopReason:'end_turn'})
})

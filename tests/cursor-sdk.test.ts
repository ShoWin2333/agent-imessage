import { describe, it, expect, vi } from 'vitest'
import { CursorBackend, cursorFailure, modelSelection } from '../src/backends/cursor.js'
import type { BackendEvent } from '../src/backends/types.js'
import { gatewayTools } from '../src/gateway/tools.js'
const route = { id:'c', cwd:'/workspace', backend:'cursor' as const, projectId:'p', projectSecretEnv:'PHOTON', senderPhoneNumber:'+15551234567', assignedPhoneNumber:'+15557654321' }
function fixture(overrides: Partial<typeof route> & {approvalPolicy?: 'auto-review'|'unrestricted';cursorSettings?: 'none'|'project-user'} = {}) {
  let finish!: (value: {id:string;status:'finished'|'cancelled';result?:string}) => void
  const done = new Promise<{id:string;status:'finished'|'cancelled';result?:string}>(resolve => { finish = resolve })
  const run = { id:'run', stream: async function*() { await done; yield {type:'assistant',message:{content:[{type:'text',text:'answer'}]}} }, wait:() => done, cancel: vi.fn(async () => { finish({id:'run',status:'cancelled'}) }) }
  const agent = { agentId:'session', send:vi.fn(async () => run), [Symbol.asyncDispose]:vi.fn(async () => {}) }
  const sdk = { create:vi.fn(async () => agent), resume:vi.fn(async () => agent) }
  const backend = new CursorBackend({...route,...overrides},'key',sdk as never)
  const events:BackendEvent[] = []; backend.onEvent = e => events.push(e)
  return {backend,agent,sdk,run,finish,events}
}
describe('Cursor SDK adapter', () => {
  it('applies explicit Cursor review and settings policies without disabling the default sandbox', async () => {
    const f=fixture({approvalPolicy:'auto-review',cursorSettings:'project-user'})
    await f.backend.openSession({cwd:route.cwd,tools:[]})
    expect(f.sdk.create).toHaveBeenCalledWith(expect.objectContaining({local:expect.objectContaining({autoReview:true,sandboxOptions:{enabled:true},settingSources:['project','user']})}))
    await f.backend.close()
    const unrestricted=fixture({approvalPolicy:'unrestricted',cursorSettings:'none'})
    await unrestricted.backend.openSession({cwd:route.cwd,tools:[]})
    expect(unrestricted.sdk.create).toHaveBeenCalledWith(expect.objectContaining({local:expect.objectContaining({autoReview:false,sandboxOptions:{enabled:false},settingSources:[]})}))
    await unrestricted.backend.close()
  })
  it('reports blocked sessions without leaking raw SDK error details', async () => {
    const f = fixture()
    await f.backend.openSession({cwd:route.cwd,tools:gatewayTools})
    f.agent.send.mockRejectedValueOnce(new Error('Agent private-id already has active run secret-token'))
    await f.backend.startTurn('session','hello')
    await expect.poll(() => f.events.at(-1)).toMatchObject({type:'completed',status:'failed',failure:'session-busy'})
    expect(JSON.stringify(f.events)).not.toContain('secret-token')
    expect(cursorFailure({message:'Invalid API key secret-token'})).toBe('authentication')
    expect(cursorFailure(new Error('private error secret-token'))).toBe('unknown')
    await f.backend.close()
  })
  it('uses local sandboxed SDK with model variants, resumes explicitly and delivers a final answer', async () => {
    expect(modelSelection('model','high','fast')).toEqual({id:'model',params:[{id:'effort',value:'high'},{id:'fast',value:'true'}]})
    const f = fixture(); await f.backend.initialize()
    await f.backend.openSession({id:'session',cwd:route.cwd,tools:gatewayTools})
    expect(f.sdk.create).not.toHaveBeenCalled()
    expect(f.sdk.resume).toHaveBeenCalledWith('session',expect.objectContaining({local:expect.objectContaining({cwd:route.cwd,settingSources:['project'],sandboxOptions:{enabled:true}})}))
    const id = await f.backend.startTurn('session','hello')
    await expect(f.backend.startTurn('session','busy')).rejects.toThrow()
    f.finish({id:'run',status:'finished',result:'final'})
    await expect.poll(() => f.events.at(-1)).toEqual({type:'completed',sessionId:'session',turnId:id,status:'completed'})
    expect(f.events).toContainEqual({type:'message',sessionId:'session',turnId:id,id,text:'final'})
    await f.backend.close()
  })
  it('cancels even while SDK send admission is pending; never sends stale results', async () => {
    const f = fixture(); let admit!: () => void
    f.agent.send.mockImplementationOnce(() => new Promise(resolve => { admit = () => resolve(f.run) }))
    await f.backend.openSession({cwd:route.cwd,tools:gatewayTools})
    const id = await f.backend.startTurn('session','hello')
    await f.backend.cancel('session',id); admit()
    await expect.poll(() => f.run.cancel.mock.calls.length).toBe(1)
    await expect.poll(() => f.events.at(-1)?.type).toBe('completed')
    expect(f.events.at(-1)).toMatchObject({status:'interrupted'})
    expect(f.events.some(e => e.type === 'message')).toBe(false)
    await f.backend.close()
  })
  it('routes all callback tools through the owning Gateway turn and rejects idle invocations', async () => {
    const f = fixture(); await f.backend.openSession({cwd:route.cwd,tools:gatewayTools})
    const options = f.sdk.create.mock.calls[0] as unknown as [{local:{customTools:Record<string,{execute:(args:object)=>Promise<unknown>}>}}]
    const tool = options[0].local.customTools.send_imessage_file!
    await expect(tool.execute({path:'file.txt'})).rejects.toThrow('No owning turn')
    const id = await f.backend.startTurn('session','send file')
    f.backend.onRequest = vi.fn(async () => ({success:true}))
    await tool.execute({path:'file.txt'})
    expect(f.backend.onRequest).toHaveBeenCalledWith({kind:'tool',sessionId:'session',turnId:id,payload:{tool:'send_imessage_file',arguments:{path:'file.txt'}}})
    await f.backend.cancel('session',id)
    await expect(tool.execute({path:'file.txt'})).rejects.toThrow()
    await f.backend.close()
  })
})

it('exposes useful activity before completion without leaking thinking or tool payloads',async()=>{
  const f=fixture()
  let release!:()=>void
  const gate=new Promise<void>(r=>{release=r})
  f.run.stream=async function*(){
    yield {type:'thinking',text:'private reasoning'} as never
    yield {type:'tool_call',call_id:'call',status:'running',name:'shell',args:{secret:'private-tool-secret'}} as never
    yield {type:'assistant',message:{content:[{type:'text',text:'partial'}]}}
    await gate
  }
  await f.backend.openSession({cwd:route.cwd,tools:[]});await f.backend.startTurn('session','hi')
  await expect.poll(()=>f.events.some(e=>e.type==='preview')).toBe(true)
  expect(f.events.filter(e=>e.type==='progress').map(e=>e.phase)).toEqual(['run-created','model-active','tool-running','generating'])
  expect(f.events.some(e=>e.type==='completed')).toBe(false)
  expect(JSON.stringify(f.events)).not.toMatch(/private reasoning|private-tool-secret/)
  release();f.finish({id:'run',status:'finished',result:'final'})
  await expect.poll(()=>f.events.at(-1)?.type).toBe('completed')
  expect(f.events.filter(e=>e.type==='message')).toHaveLength(1)
  await f.backend.close()
})
it('distinguishes explicit timeouts, network failures and upstream aborts from user cancellation',async()=>{
  expect(cursorFailure({message:'This operation was aborted',code:'[unknown] [canceled]'})).toBe('aborted')
  expect(cursorFailure(new Error('outer',{cause:{code:'ETIMEDOUT'}}))).toBe('timeout')
  expect(cursorFailure({cause:{code:'ECONNRESET'}})).toBe('network')
  expect(cursorFailure({code:'resource_exhausted'})).toBe('rate-limit')
  const f=fixture();await f.backend.openSession({cwd:route.cwd,tools:[]})
  await f.backend.startTurn('session','hi');f.finish({id:'run',status:'cancelled'})
  await expect.poll(()=>f.events.at(-1)).toMatchObject({type:'completed',status:'failed',failure:'aborted'})
  expect(f.events.some(e=>e.type==='message')).toBe(false)
  await f.backend.close()
})

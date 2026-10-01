import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worker } from 'node:worker_threads'
import { IsolatedCursorBackend } from '../src/backends/isolated-cursor.js'
import { BackendOperationError, backendDiagnostic, diagnosticText, readBackendDiagnostic } from '../src/backends/failure.js'
import type { BackendEvent } from '../src/backends/types.js'

const route = {id:'c',cwd:'/workspace',backend:'cursor' as const,projectId:'p',projectSecretEnv:'PHOTON',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
class FakeWorker extends EventEmitter {
  error: unknown
  hold: string | undefined
  postMessage = vi.fn((message: Record<string,any>) => {
    if (!message.method || this.hold === message.method) return
    queueMicrotask(() => {
      if (message.method === 'startTurn') this.emit('message',{type:'event',event:{type:'started',sessionId:message.sessionId,turnId:'turn'}})
      this.emit('message',{type:'result',id:message.id,...(this.error ? {error:this.error} : {result:message.method === 'openSession' ? {id:message.options.id ?? 'new-session',cwd:message.options.cwd} : message.method === 'startTurn' ? 'turn' : undefined})})
    })
  })
  terminate = vi.fn(async () => {this.emit('exit',0);return 0})
}
function fixture() {
  const workers: FakeWorker[] = []
  const factory = vi.fn(() => {const worker=new FakeWorker();workers.push(worker);return worker as unknown as Worker})
  const backend = new IsolatedCursorBackend(route,'private-api-key',['PHOTON'],factory)
  const events:BackendEvent[]=[];backend.onEvent=event=>events.push(event)
  const closed=vi.fn();backend.onClose=closed
  return {backend,workers,factory,closed,events}
}
afterEach(()=>vi.useRealTimers())
describe('Cursor worker model cache lifecycle',()=>{
  it('replaces only on changed selection, resumes the same session and never replays a turn',async()=>{
    const f=fixture();await f.backend.initialize()
    const options={id:'old-session',cwd:route.cwd,tools:[],model:'old-model'}
    await f.backend.openSession(options);await f.backend.openSession(options)
    expect(f.factory).toHaveBeenCalledTimes(1)
    await f.backend.openSession({...options,model:'new-model'})
    expect(f.factory).toHaveBeenCalledTimes(2)
    expect(f.workers[0]!.terminate).toHaveBeenCalledOnce()
    expect(f.workers[0]!.postMessage.mock.calls.map(([m])=>m.method)).toEqual(['initialize','openSession','openSession','close'])
    expect(f.workers[1]!.postMessage.mock.calls.map(([m])=>m.method)).toEqual(['initialize','openSession'])
    expect(f.workers[1]!.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({options:{...options,model:'new-model'}}))
    expect(f.closed).not.toHaveBeenCalled()
    f.workers[0]!.emit('error',new Error('retired worker'));f.workers[0]!.emit('exit',1)
    expect(f.closed).not.toHaveBeenCalled()
    await f.backend.startTurn('old-session','one explicit message')
    expect(f.workers.flatMap(w=>w.postMessage.mock.calls).filter(([m])=>m.method==='startTurn')).toHaveLength(1)
    await f.backend.close()
  })
  it('rejects a model change during pending admission and a running turn without replacing workers',async()=>{
    const f=fixture();const options={id:'old-session',cwd:route.cwd,tools:[],model:'old-model'}
    await f.backend.openSession(options)
    f.workers[0]!.hold='startTurn'
    const start=f.backend.startTurn('old-session','once')
    await expect(f.backend.openSession({...options,model:'new-model'})).rejects.toMatchObject({diagnostic:{failure:'session-busy'}})
    const request=f.workers[0]!.postMessage.mock.calls.at(-1)![0]
    f.workers[0]!.emit('message',{type:'event',event:{type:'started',sessionId:'old-session',turnId:'turn'}})
    f.workers[0]!.emit('message',{type:'result',id:request.id,result:'turn'});await start
    await expect(f.backend.openSession({...options,model:'new-model'})).rejects.toThrow()
    expect(f.factory).toHaveBeenCalledTimes(1)
    f.workers[0]!.emit('message',{type:'event',event:{type:'completed',sessionId:'old-session',turnId:'turn',status:'completed'}})
    f.workers[0]!.hold=undefined
    await f.backend.openSession({...options,model:'new-model'})
    expect(f.factory).toHaveBeenCalledTimes(2)
    await f.backend.close()
  })
  it('stops on failed retirement without retrying admission or sending anything',async()=>{
    const f=fixture();const options={id:'old-session',cwd:route.cwd,tools:[],model:'old-model'}
    await f.backend.openSession(options)
    f.workers[0]!.error={stage:'worker-refresh',failure:'local-storage',causes:[{name:'Error',code:'SQLITE_BUSY'}]}
    await expect(f.backend.openSession({...options,model:'new-model'})).rejects.toMatchObject({diagnostic:{stage:'worker-refresh',failure:'local-storage'}})
    expect(f.factory).toHaveBeenCalledTimes(1)
    expect(f.workers[0]!.postMessage.mock.calls.map(([m])=>m.method)).toEqual(['openSession','close'])
    expect(f.closed).toHaveBeenCalledOnce()
  })
  it('retains timeout phase and never retries a possibly submitted turn',async()=>{
    vi.useFakeTimers();const f=fixture();await f.backend.openSession({cwd:route.cwd,tools:[]})
    f.workers[0]!.hold='startTurn'
    const start=f.backend.startTurn('new-session','once')
    const rejected=expect(start).rejects.toMatchObject({diagnostic:{stage:'turn-start',failure:'timeout'}})
    await vi.advanceTimersByTimeAsync(60_000);await rejected
    expect(f.workers[0]!.postMessage.mock.calls.filter(([m])=>m.method==='startTurn')).toHaveLength(1)
    expect(f.closed).toHaveBeenCalledOnce()
  })
})
describe('allowlisted failure diagnostics',()=>{
  it('retains category, phase and a bounded cause chain while dropping private content',()=>{
    const error=Object.assign(new Error('Cannot use this model: private-model. Available models: private-list'),{name:'ConfigurationError',code:'BAD_MODEL_NAME',status:400,endpoint:'https://private-url',requestId:'private-id',cause:Object.assign(new Error('Bearer private-token; unrelated private message'),{code:'ECONNRESET'})})
    const d=backendDiagnostic(error,'session-resume')
    expect(d).toEqual({stage:'session-resume',failure:'model-unavailable',causes:[{name:'ConfigurationError',code:'BAD_MODEL_NAME',status:400},{name:'Error',code:'ECONNRESET'}]})
    expect(diagnosticText(d)).toContain('stage=session-resume')
    expect(JSON.stringify(d)).not.toMatch(/private|Bearer|Available models/)
    expect(backendDiagnostic(new BackendOperationError(d),'initialize')).toEqual(d)
    const cycle=Object.assign(new Error('private'),{cause:null as unknown});cycle.cause=cycle
    expect(backendDiagnostic(cycle,'turn-stream').causes).toHaveLength(1)
  })
  it('rejects injected names, codes, stages and categories from worker metadata',()=>{
    const d=readBackendDiagnostic({stage:'private-stage',failure:'private-failure',causes:[{name:'private-name',code:'private-token',status:200,message:'private-message',cause:{name:'private'}}]},'session-create')
    expect(d).toEqual({stage:'session-create',failure:'unknown',causes:[{name:'Error'}]})
    expect(JSON.stringify(d)).not.toContain('private')
  })
  it('propagates the safe worker error instead of a boolean generic error',async()=>{
    const f=fixture();f.workers[0]!.error=backendDiagnostic(Object.assign(new Error('Agent private-id not found private-token'),{name:'AgentNotFoundError',code:'agent_not_found'}),'session-resume')
    await expect(f.backend.openSession({id:'session',cwd:route.cwd,tools:[]})).rejects.toMatchObject({diagnostic:{stage:'session-resume',failure:'session-not-found',causes:[{name:'AgentNotFoundError',code:'agent_not_found'}]}})
    f.workers[0]!.error=undefined;await f.backend.close()
  })
})
it('refreshes after a failed first model selection without retrying the failed request',async()=>{
  const f=fixture();f.workers[0]!.error={stage:'session-resume',failure:'model-unavailable',causes:[{name:'ConfigurationError'}]}
  await expect(f.backend.openSession({id:'old-session',cwd:route.cwd,tools:[],model:'invalid-model'})).rejects.toThrow()
  f.workers[0]!.error=undefined
  await f.backend.openSession({id:'old-session',cwd:route.cwd,tools:[],model:'valid-model'})
  expect(f.factory).toHaveBeenCalledTimes(2)
  expect(f.workers[0]!.postMessage.mock.calls.filter(([m])=>m.method==='openSession')).toHaveLength(1)
  expect(f.workers[1]!.postMessage.mock.calls.filter(([m])=>m.method==='openSession')).toHaveLength(1)
  expect(f.workers.flatMap(w=>w.postMessage.mock.calls).filter(([m])=>m.method==='startTurn')).toHaveLength(0)
  await f.backend.close()
})

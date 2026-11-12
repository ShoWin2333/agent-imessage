import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DshNativeHost, resultFromEvents } from '../src/plugin/native.js'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function runtime() {
  const handlers = new Map<string, Set<(...args: any[]) => void>>()
  const emit = (event: string, ...args: any[]) => { for (const fn of handlers.get(event) ?? []) fn(...args) }
  const id = SessionId('channels-binding-synthetic')
  const liveSession = Session.create(id, [], { ...Session.create(id).header, cwd: '/tmp' })
  const agent = { id: liveSession.id, session: liveSession, inbox: { clear: vi.fn(), remove: vi.fn(() => true) }, cancel: vi.fn(), followup: vi.fn(), ctx: undefined as unknown as Context }
  const dispose = vi.fn(async () => { emit('agent/disposed', { agent }) })
  const flush = vi.fn(async () => true)
  const ctx = {
on: (event: string, fn: (...args: any[]) => void) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(fn); return () => handlers.get(event)!.delete(fn) },
    agents: { get: vi.fn(() => undefined), create: vi.fn(async () => ({ agent, dispose })), resume: vi.fn(async () => ({ agent, dispose })) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'synthetic', model: 'no-paid-model' }) }, agentPresets: { defaultId: 'synthetic-preset', mount: vi.fn() },
    permissionPresets: { resolve: vi.fn(), set: vi.fn() }, sessions: { flush },
    sessionPersistence: { stat: vi.fn(async () => ({ header: { cwd: '/tmp', agentPreset: 'synthetic-preset' } })), open: vi.fn(async () => ({ read: async () => ({ events: [] }), close: vi.fn(async () => { }) })) },
  } as unknown as Context
  agent.ctx = ctx
  return { ctx, agent, emit, flush, dispose, handlers, host: new DshNativeHost(ctx, '/tmp', 'workspace-write', 'binding') }
}
it('uses real DSH Session records for rejected claim and native interrupted-turn repair', () => {
  const session = Session.create(SessionId('synthetic')), input = createUserMessage({ content: [{ type: 'text', text: 'synthetic' }], source: { kind: 'user' } })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] })
  session.append('turn/start', { turn: 1 })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  const events = session.snapshotEvents()
  expect(resultFromEvents([...events, ...interruptedTurnClosers(events)], input.id)).toEqual({ text: '', reason: 'interrupted' })
})
it('subscribes before followup, matches exact agent/input/turn, awaits terminal flush', async () => {
  const f = runtime(), session = await f.host.open()
  let input: any
  f.agent.followup.mockImplementation(value => { input = value; f.emit('agent/inbox/claimed', { agent: f.agent, message: value, turn: 7 }) })
  const progress = vi.fn(), operation = session.submit('owned-input', 'synthetic', progress)
  await operation.admitted
  expect(input).toMatchObject({ id: 'owned-input', role: 'user', source: { kind: 'dsh-channels' } })
  expect(Object.isFrozen(input)).toBe(true)
  f.emit('session/event', {}, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  f.emit('session/event', f.agent.session, { type: 'assistant/message', data: { turn: 8, message: { content: [{ type: 'text', text: 'other turn' }] } } })
  f.emit('session/event', f.agent.session, { type: 'step/start', data: { turn: 7 } })
  expect(progress).toHaveBeenCalledTimes(1)
  f.emit('session/event', f.agent.session, { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'reasoning', text: 'secret reasoning' }, { type: 'text', text: 'answer' }] } } })
  const terminalFlush = deferred<boolean>(); f.flush.mockImplementationOnce(() => terminalFlush.promise)
  let completed = false; void operation.result.then(() => { completed = true })
  f.emit('session/event', f.agent.session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  await Promise.resolve(); expect(completed).toBe(false)
  terminalFlush.resolve(true); expect(await operation.result).toEqual({ text: 'answer', reason: 'completed' })
  await session.close(); expect(f.dispose).toHaveBeenCalledTimes(1)
  expect([...f.handlers.values()].every(set => set.size === 0)).toBe(true)
})
it('resume clears quarantined native inbox before new input, flushes it, preserves native policy', async () => {
  const f = runtime(), session = await f.host.open('channels-binding-synthetic')
  expect(f.agent.inbox.clear).toHaveBeenCalledTimes(1)
  expect(f.flush).toHaveBeenCalledWith(f.agent.session)
  expect(f.ctx.permissionPresets.set).not.toHaveBeenCalled()
  session.cancel(); expect(f.agent.cancel).not.toHaveBeenCalled()
  await session.close()
})

it.each(['create','resume'] as const)('forwards a creation-only cancellation signal to %s and detaches it after success', async mode => {
  const f=runtime(),binding=new AbortController()
  const session=await f.host.open(mode==='resume'?'channels-binding-synthetic':undefined,binding.signal)
  const options=(mode==='resume'?vi.mocked(f.ctx.agents.resume):vi.mocked(f.ctx.agents.create)).mock.calls[0]![0]
  expect(options.signal).toBeInstanceOf(AbortSignal)
  expect(options.signal).not.toBe(binding.signal)
  binding.abort(new Error('Binding stopped after open'))
  expect(options.signal?.aborted).toBe(false)
  await session.close()
})

it('refuses an already cancelled opening before touching the native factory', async () => {
  const f=runtime(),binding=new AbortController()
  binding.abort(new Error('Binding already stopped'))
  await expect(f.host.open(undefined,binding.signal)).rejects.toThrow('Binding already stopped')
  expect(f.ctx.agents.create).not.toHaveBeenCalled()
  expect(f.ctx.agents.resume).not.toHaveBeenCalled()
})
it('shares the exact desktop-opened session without clearing or cancelling desktop work', async () => {
  const f = runtime()
  const agent = f.agent as typeof f.agent & { status: string; steer: ReturnType<typeof vi.fn> }
  agent.status = 'running'
  agent.steer = vi.fn()
  vi.mocked(f.ctx.agents.get).mockReturnValue(agent as never)
  agent.session.append('turn/start', { turn: 1 })

  const session = await f.host.open(agent.id)
  expect(f.ctx.agents.resume).not.toHaveBeenCalled()
  expect(agent.inbox.clear).not.toHaveBeenCalled()
  const operation = session.submit('telegram-input', 'Telegram request', () => {})
  await operation.admitted
  expect(agent.followup).toHaveBeenCalledOnce()
  expect(agent.steer).not.toHaveBeenCalled()

  session.cancel()
  expect(agent.inbox.remove).toHaveBeenCalledWith('telegram-input')
  expect(agent.cancel).not.toHaveBeenCalled()
  expect(await operation.result).toMatchObject({ reason: 'interrupted' })
  await session.close()
  expect(f.dispose).not.toHaveBeenCalled()
  expect(session.isLive?.()).toBe(false)
})

it('reuses the matching desktop Agent when the desktop wins the resume race', async () => {
  const f = runtime()
  vi.mocked(f.ctx.agents.resume).mockImplementationOnce(async () => {
    vi.mocked(f.ctx.agents.get).mockReturnValue(f.agent as never)
    throw Object.assign(new Error('Synthetic concurrent resume'), { name: 'SessionAlreadyOwnedError' })
  })
  const session = await f.host.open(f.agent.id)
  expect(session.id).toBe(f.agent.id)
  expect(f.agent.inbox.clear).not.toHaveBeenCalled()
  await session.close()
  expect(f.dispose).not.toHaveBeenCalled()
})

it.each(['channel-first','desktop-first'] as const)('preserves a desktop turn and its queue on channel cancel/close (%s)', async order => {
  const f=runtime(),live=f.agent as any
  live.status='running'
  live.inbox.nextTurn=[createUserMessage({content:[{type:'text',text:'desktop queued'}],source:{kind:'user'}})]
  live.inbox.nextStep=[]
  if(order==='desktop-first') vi.mocked(f.ctx.agents.get).mockReturnValue(live)
  const session=await f.host.open(order==='desktop-first'?live.id:undefined)
  vi.mocked(f.ctx.agents.get).mockReturnValue(live)
  live.session.append('turn/start',{turn:1})
  session.cancel()
  await session.close()
  expect(live.cancel).not.toHaveBeenCalled()
  expect(live.inbox.remove).not.toHaveBeenCalled()
  expect(f.dispose).not.toHaveBeenCalled()
  expect(live.inbox.nextTurn).toHaveLength(1)
})

it('cancels a channel-owned turn with keepInbox even when the channel created the Agent', async () => {
  const f=runtime(),live=f.agent as any,session=await f.host.open()
  vi.mocked(f.ctx.agents.get).mockReturnValue(live)
  live.session.append('turn/start',{turn:1})
  live.followup.mockImplementation((message:any)=>f.emit('agent/inbox/claimed',{agent:live,message,turn:1}))
  const operation=session.submit('channel-input','task',()=>{})
  await operation.admitted
  session.cancel()
  expect(live.cancel).toHaveBeenCalledWith({kind:'user'},{keepInbox:true})
  expect(live.inbox.clear).not.toHaveBeenCalled()
  await session.close();await operation.result
})

it('does not attach to a desktop Agent outside the binding workspace or top-level scope', async () => {
  const f = runtime()
  vi.mocked(f.ctx.agents.get).mockReturnValue(f.agent as never)
  const otherWorkspace = new DshNativeHost(f.ctx, '/different', 'workspace-write', 'binding')
  await expect(otherWorkspace.open(f.agent.id)).rejects.toThrow('Session binding mismatch')
  const child = { ...f.agent, session: Session.create(f.agent.session.id, [], { ...f.agent.session.header, origin: 'subagent', delegationDepth: 1 }) }
  vi.mocked(f.ctx.agents.get).mockReturnValue(child as never)
  await expect(f.host.open(f.agent.id)).rejects.toThrow('Session binding mismatch')
  expect(f.ctx.agents.resume).not.toHaveBeenCalled()
})

it('rejects wrong binding identity even when workspace matches; closes read handles', async () => {
  const f = runtime()
  await expect(f.host.open('channels-other-binding-synthetic')).rejects.toThrow('mismatch')
  await expect(f.host.inspect('channels-other-binding-synthetic', 'input')).rejects.toThrow('mismatch')
  expect(f.ctx.agents.resume).not.toHaveBeenCalled()
})
it('discarded and disposed inputs terminate without waiting for unrelated turns', async () => {
  const f = runtime(), session = await f.host.open(), a = session.submit('a', 'a', () => { }), b = session.submit('b', 'b', () => { })
  await Promise.all([a.admitted, b.admitted])
  f.emit('agent/inbox/discarded', { agent: {}, message: { id: 'a' } })
  f.emit('agent/inbox/discarded', { agent: f.agent, message: { id: 'a' } })
  expect((await a.result).reason).toBe('interrupted')
  // This fixture has no stored cancellation boundary; teardown cannot claim
  // durability from a live flush after its writer has already been removed.
  await session.close(); expect((await b.result).reason).toBe('uncertain')
})
it('failed durability is refused and disposes the exact owned handle', async () => {
  const f = runtime(); f.flush.mockResolvedValueOnce(false)
  await expect(f.host.open()).rejects.toThrow('durability unavailable')
  expect(f.dispose).toHaveBeenCalledTimes(1)
})

it('steers running input at next-step, keeps a fixed turn reply owner, and follows up idle input', async () => {
  const f = runtime(), session = await f.host.open()
  const live = f.agent as typeof f.agent & {status:string;steer:ReturnType<typeof vi.fn>}
  live.status='idle';live.steer=vi.fn()
  const claim=(input:any)=>f.emit('agent/inbox/claimed',{agent:live,message:input,turn:11})
  live.followup.mockImplementation(input=>{live.status='running';claim(input)})
  live.steer.mockImplementation(claim)
  const a=session.submit('a','original',()=>{}), b=session.submit('b','refinement',()=>{})
  await Promise.all([a.admitted,b.admitted])
  expect(live.followup).toHaveBeenCalledTimes(1);expect(live.steer).toHaveBeenCalledTimes(1)
  expect(live.steer.mock.calls[0]![0].id).toBe('b')
  f.emit('session/event',live.session,{type:'assistant/message',data:{turn:11,message:{content:[{type:'text',text:'one answer'}]}}})
  f.emit('session/event',live.session,{type:'turn/end',data:{turn:11,reason:{kind:'completed'}}})
  expect(await a.result).toEqual({text:'one answer',reason:'completed'})
  expect(await b.result).toEqual({text:'',reason:'completed',suppressed:true})
  live.status='idle';const c=session.submit('c','new turn',()=>{});expect(live.followup).toHaveBeenCalledTimes(2)
  await session.close();await c.result
})
it('native closing/cancel race may claim steering in a fresh turn without suppressing its reply',async()=>{
  const f=runtime(),session=await f.host.open(),live=f.agent as any
  live.status='running';live.followup.mockImplementation((input:any)=>f.emit('agent/inbox/claimed',{agent:live,message:input,turn:11}));live.steer=vi.fn((input:any)=>f.emit('agent/inbox/claimed',{agent:live,message:input,turn:12}))
  const prior=session.submit('prior','original',()=>{});await prior.admitted
  const a=session.submit('after-boundary','new turn',()=>{});await a.admitted
  f.emit('session/event',live.session,{type:'turn/end',data:{turn:11,reason:{kind:'completed'}}});await prior.result
  f.emit('session/event',live.session,{type:'turn/end',data:{turn:12,reason:{kind:'completed'}}})
  expect(await a.result).toEqual({text:'',reason:'completed'});expect(live.followup).toHaveBeenCalledTimes(1);expect(live.steer).toHaveBeenCalledTimes(1);await session.close()
})
it.each(['disposed','flush-failed','close'] as const)('keeps same-turn steering suppressed on %s',async mode=>{
 const f=runtime(),session=await f.host.open(),live=f.agent as any;live.status='running';live.steer=vi.fn((input:any)=>f.emit('agent/inbox/claimed',{agent:live,message:input,turn:13}));live.followup.mockImplementation(live.steer)
 const a=session.submit('a','original',()=>{}),b=session.submit('b','extra',()=>{});await Promise.all([a.admitted,b.admitted])
 if(mode==='flush-failed'){f.flush.mockResolvedValue(false);f.emit('session/event',live.session,{type:'turn/end',data:{turn:13,reason:{kind:'completed'}}})}
 else if(mode==='disposed')f.emit('agent/disposed',{agent:live})
 else await session.close()
 expect((await a.result).suppressed).not.toBe(true);expect((await b.result).suppressed).toBe(true);await session.close()
})
it('reconstructs the unique same-turn reply owner from durable next-turn/next-step claims',()=>{
 const s=Session.create(SessionId('synthetic'));const a=createUserMessage({content:[{type:'text',text:'a'}],source:{kind:'user'}}),b=createUserMessage({content:[{type:'text',text:'b'}],source:{kind:'user'}})
 s.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[a]});s.append('turn/start',{turn:1});s.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});s.append('agent/inbox/spliced',{target:'next-step',start:0,inserted:[b]});s.append('agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[]});s.append('turn/end',{turn:1,reason:{kind:'completed'} as never})
 expect(resultFromEvents(s.snapshotEvents(),a.id)?.suppressed).not.toBe(true);expect(resultFromEvents(s.snapshotEvents(),b.id)).toEqual({text:'',reason:'completed',suppressed:true})
})
it('admission flush failure retains suppressed steering result while rejecting admission',async()=>{
 const f=runtime(),session=await f.host.open(),live=f.agent as any;live.status='running';live.steer=vi.fn((input:any)=>f.emit('agent/inbox/claimed',{agent:live,message:input,turn:14}));live.followup.mockImplementation(live.steer)
 const a=session.submit('a','original',()=>{});await a.admitted;f.flush.mockResolvedValueOnce(false)
 const b=session.submit('b','extra',()=>{});await expect(b.admitted).rejects.toThrow('durability unavailable')
 expect((await b.result).suppressed).toBe(true);await session.close();await a.result
})
it('queues channel input behind a host-owned turn instead of steering or owning its approvals and output',async()=>{
 const f=runtime(),session=await f.host.open(),live=f.agent as any;live.status='running';live.steer=vi.fn();vi.mocked(f.ctx.agents.get).mockReturnValue(live)
 const foreign=createUserMessage({content:[{type:'text',text:'host input'}],source:{kind:'user'}})
 live.session.append('turn/start',{turn:20});live.session.append('user/message',foreign,{surfaceOp:'append'});f.emit('agent/inbox/claimed',{agent:live,message:foreign,turn:20})
 const question=vi.fn();const operation=session.submit('channel','channel task',()=>{},{question});await operation.admitted
 expect(live.steer).not.toHaveBeenCalled();expect(live.followup).toHaveBeenCalledTimes(1)
 f.emit('session/event',live.session,{type:'assistant/message',data:{turn:20,message:{content:[{type:'text',text:'host-only response'}]}}});f.emit('session/event',live.session,{type:'turn/end',data:{turn:20,reason:{kind:'completed'}}})
 let resolved=false;void operation.result.then(()=>{resolved=true});await Promise.resolve();expect(resolved).toBe(false)
 const input=live.followup.mock.calls[0][0];live.session.append('turn/end',{turn:20,reason:{kind:'completed'}});live.session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[input]});live.session.append('turn/start',{turn:21});live.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});f.emit('agent/inbox/claimed',{agent:live,message:input,turn:21})
 const response={turn:21,step:1,message:{content:[{type:'text',text:'channel response'}]}};live.session.append('assistant/message',response as never,{surfaceOp:'append'});f.emit('session/event',live.session,{type:'assistant/message',data:response});live.session.append('turn/end',{turn:21,reason:{kind:'completed'}});f.emit('session/event',live.session,{type:'turn/end',data:{turn:21,reason:{kind:'completed'}}})
 const result=await operation.result;expect(result).toEqual({text:'channel response',reason:'completed'});expect(resultFromEvents(live.session.snapshotEvents(),'channel')).toEqual(result);await session.close()
})
it.each([undefined,'high'] as const)('resumes the saved native model and effort instead of the binding default (effort %s)',async reasoningEffort=>{
 const f=runtime(),selection={provider:'synthetic-codex',model:'synthetic-sol',...(reasoningEffort?{reasoningEffort}:{})}
 vi.mocked(f.ctx.sessionPersistence.open).mockResolvedValue({read:async()=>({events:[{type:'request/header',data:{header:{config:selection}}}]}),close:vi.fn(async()=>{})} as never)
 const host=new DshNativeHost(f.ctx,'/tmp','workspace-write','binding',{provider:'binding',model:'other',reasoningEffort:'inherited'})
 const session=await host.open('channels-binding-synthetic')
 expect(f.ctx.agents.create).not.toHaveBeenCalled()
 expect(f.ctx.agents.resume).toHaveBeenCalledWith(expect.objectContaining({resumeSessionId:'channels-binding-synthetic',agentOptions:selection}))
 await session.close()
})

it.each([undefined,'high'] as const)('passes the full selected model to new native Agents (effort %s)',async reasoningEffort=>{
 const f=runtime(),selection={provider:'configured',model:'selected',...(reasoningEffort?{reasoningEffort}:{})}
 const session=await new DshNativeHost(f.ctx,'/tmp','workspace-write','binding',selection).open()
 expect(f.ctx.agents.create).toHaveBeenCalledWith(expect.objectContaining({agentOptions:selection}))
 await session.close()
})

it('reads the committed cancellation after teardown instead of flushing a removed writer',async()=>{
  const f=runtime(),native=await f.host.open()
  let removed=false
  f.agent.followup.mockImplementation(message=>f.agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]}))
  const operation=native.submit('queued-during-approval','synthetic',()=>{});await operation.admitted
  f.flush.mockImplementation(async()=>{if(removed)throw new Error('writer removed');return true})
  f.dispose.mockImplementation(async()=>{
    removed=true
    f.agent.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled'})
    f.emit('agent/inbox/discarded',{agent:f.agent,message:{id:'queued-during-approval'}})
    f.emit('agent/disposed',{agent:f.agent})
  })
  vi.mocked(f.ctx.sessionPersistence.open).mockResolvedValue({read:async()=>({events:f.agent.session.snapshotEvents()}),close:async()=>{}} as any)
  await native.close()
  expect(await operation.result).toEqual({text:'已取消。',reason:'interrupted'})
  expect(f.flush.mock.invocationCallOrder.at(-1)).toBeLessThan(f.dispose.mock.invocationCallOrder[0]!)
})
it('joins an already-started final flush before disposing its writer',async()=>{
  const f=runtime(),native=await f.host.open()
  f.agent.followup.mockImplementation(message=>f.emit('agent/inbox/claimed',{agent:f.agent,message,turn:1}))
  const operation=native.submit('input','synthetic',()=>{});await operation.admitted
  const release=deferred<boolean>();f.flush.mockImplementationOnce(()=>release.promise)
  f.emit('session/event',f.agent.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
  const closing=native.close();await Promise.resolve();expect(f.dispose).not.toHaveBeenCalled()
  release.resolve(true);await closing;expect((await operation.result).reason).toBe('completed');expect(f.dispose).toHaveBeenCalledOnce()
})

it('keeps a claimed turn alive beyond the unclaimed-input deadline', async () => {
  vi.useFakeTimers()
  const f=runtime(),session=await f.host.open()
  try {
    f.agent.followup.mockImplementation(message=>f.emit('agent/inbox/claimed',{agent:f.agent,message,turn:1}))
    const operation=session.submit('long-task','synthetic',()=>{}),settled=vi.fn()
    void operation.result.then(settled)
    await operation.admitted
    await vi.advanceTimersByTimeAsync(31*60_000)
    expect(settled).not.toHaveBeenCalled()
    f.emit('session/event',f.agent.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'finished'}]}}})
    f.emit('session/event',f.agent.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
    expect(await operation.result).toEqual({text:'finished',reason:'completed'})
  } finally {await session.close();vi.useRealTimers()}
})

it('revokes an unclaimed native admission before settling its timeout', async () => {
  vi.useFakeTimers()
  const f=runtime(),session=await f.host.open(),inbox=new Set<string>()
  try {
    f.agent.followup.mockImplementation(message=>{inbox.add(message.id)})
    f.agent.inbox.remove.mockImplementation(id=>inbox.delete(id))
    const operation=session.submit('unclaimed','synthetic',()=>{})
    await operation.admitted
    await vi.advanceTimersByTimeAsync(30*60_000)
    expect(await operation.result).toMatchObject({reason:'interrupted'})
    expect(f.agent.inbox.remove).toHaveBeenCalledWith('unclaimed')
    expect(inbox.has('unclaimed')).toBe(false)
  } finally {await session.close();vi.useRealTimers()}
})

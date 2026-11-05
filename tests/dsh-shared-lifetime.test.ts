import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import { DshNativeHost } from '../src/plugin/native.js'
import { ChannelBridge } from '../src/plugin/bridge.js'
import type { ChannelMessage } from '../src/channels/types.js'

async function runtime(mount:()=>Promise<void> = async()=>{}) {
  const root=new Context()
  // The real application's service world may be isolated from root defaults.
  const world=root.isolate('agents')
  const assembling=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const services=await world.plugin(ctx=>{
    ctx.provide('llm',{} as never)
    ctx.provide('systemPrompt',{
      variable:()=>()=>{},tools:()=>()=>{},
      assemble:async ({signal}:{signal:AbortSignal})=>{
        assembling.resolve()
        await Promise.race([release.promise,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))])
        signal.throwIfAborted()
        return []
      },
    } as never)
    ctx.provide('agentPresets',{defaultId:'test',mount,serviceFor:()=>undefined} as never)
    ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'})} as never)
    ctx.provide('permissionPresets',{resolve:()=>{},set:()=>{}} as never)
    ctx.on('session/flush',async()=>{})
  })
  const agents=await world.plugin(Agents),sessions=await world.plugin(Sessions)
  const projections=await world.plugin(Projections),tools=await world.plugin(Tools)
  const loop=await world.plugin(AgentLoop,{})
  return {world,assembling,release,loop,close:async()=>{
    release.resolve()
    await loop.dispose();await tools.dispose();await projections.dispose()
    await sessions.dispose();await agents.dispose();await services.dispose()
  }}
}

it('keeps a real shared Agent and desktop inbox through full transport-plugin unload, then disposes it with the host', async () => {
  const {world,assembling,release,loop,close}=await runtime()
  const binding=new AbortController()
  let creationSignal:AbortSignal|undefined
  const stopObserving=world.on('agent/created',({signal})=>{creationSignal=signal})
  let native!:Awaited<ReturnType<DshNativeHost['open']>>
  const transport=await world.plugin({
    inject:['agents','sessions','agentPresets','agentDefaultModel','permissionPresets'],
    async apply(ctx:Context) {
      const lifetime=ctx.root.extend({[Context.isolate]:ctx[Context.isolate]})
      native=await new DshNativeHost(ctx,'/tmp','workspace-write','binding',undefined,undefined,'telegram',lifetime).open(undefined,binding.signal)
      ctx.effect(()=>()=>{binding.abort();return native.close()})
    },
  })
  try {
    const agent=world.agents.get(native.id as never)!
    const active=createUserMessage({content:[{type:'text',text:'desktop active'}],source:{kind:'user'}})
    const queued=createUserMessage({content:[{type:'text',text:'desktop queued'}],source:{kind:'user'}})
    agent.followup(active)
    await assembling.promise
    agent.followup(queued)
    expect(agent.status).toBe('running')
    await transport.dispose()
    expect(world.agents.get(agent.id)).toBe(agent)
    expect(agent.status).toBe('running')
    expect(creationSignal?.aborted).toBe(false)
    expect(agent.inbox.nextTurn.map(message=>message.id)).toEqual([queued.id])
    expect(agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced' && event.data.outcome==='canceled')).toBe(false)
    // Provider shutdown remains authoritative; no Agent is leaked past host stop.
    await loop.dispose()
    expect(world.agents.get(agent.id)).toBeUndefined()
    expect(agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced' && event.data.outcome==='canceled')).toBe(true)
  } finally {
    release.resolve()
    stopObserving();await transport.dispose();await close()
  }
})

it('unloads promptly while real root-owned Agent preset initialization is suspended', async () => {
  const initializing=Promise.withResolvers<void>(),releasePreset=Promise.withResolvers<void>()
  const {world,close}=await runtime(async()=>{initializing.resolve();await releasePreset.promise})
  let bridge!:ChannelBridge
  let writes=0
  const created=vi.fn()
  const stopObserving=world.on('agent/created',created)
  const transport=await world.plugin({
    inject:['agents','sessions','agentPresets','agentDefaultModel','permissionPresets'],
    apply(ctx:Context) {
      const lifetime=ctx.root.extend({[Context.isolate]:ctx[Context.isolate]})
      const host=new DshNativeHost(ctx,'/tmp','workspace-write','binding',undefined,undefined,'telegram',lifetime)
      bridge=new ChannelBridge(host,{read:()=>({receipts:[]}),write:async()=>{writes++}})
      ctx.effect(()=>()=>bridge.close())
    },
  })
  const send=vi.fn(async()=>{})
  const message={id:'input',text:'task',send,responding:async(fn:()=>Promise<unknown>)=>fn()} as ChannelMessage
  const admission=bridge.receive(message).catch(error=>error)
  try {
    await initializing.promise
    // Do not release the gate: unloading itself must cancel factory setup.
    await transport.dispose()
    expect(await admission).toBeInstanceOf(Error)
    expect(world.agents.list()).toEqual([])
    expect(created).not.toHaveBeenCalled()
    expect(writes).toBe(0)
    expect(send).not.toHaveBeenCalled()
    releasePreset.resolve()
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(world.agents.list()).toEqual([])
    expect(created).not.toHaveBeenCalled()
  } finally {
    releasePreset.resolve();stopObserving();await transport.dispose();await close()
  }
})

it.each([undefined, 'high'] as const)('retains the full configured model in the real Agent runtime (effort %s)', async reasoningEffort => {
  const {world,close}=await runtime()
  const selection={provider:'configured',model:'selected',...(reasoningEffort?{reasoningEffort}:{})}
  const native=await new DshNativeHost(world,'/tmp','workspace-write','binding',selection,undefined,'telegram',
    world.root.extend({[Context.isolate]:world[Context.isolate]})).open()
  try {
    const agent=world.agents.get(native.id as never)!
    expect(agent.options).toMatchObject(selection)
    if ('model' in agent) {
      expect((agent.model as {current():unknown}).current()).toEqual(selection)
    } else {
      // 0.2.1 keeps the live selection in the installed scoped assembly and
      // request hooks. Exercise those real hooks, including clearing an
      // inherited effort when the user selected adapter defaults.
      await world.waterfall('system-prompt/assemble',{} as never,{} as never,
        async()=>({variables:{}}) as never)
      const config=await world.waterfall('agent/request',{} as never,
        async()=>({provider:'wrong',model:'wrong',reasoningEffort:'inherited'}) as never)
      expect(config).toEqual(selection)
    }
  } finally {await native.close();await close()}
})

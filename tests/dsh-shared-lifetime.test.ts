import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Tools from '@deepseek-ai/dsh-tools'
import { DshNativeHost } from '../src/plugin/native.js'

it('keeps a real shared Agent and desktop inbox through full transport-plugin unload, then disposes it with the host', async () => {
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
    ctx.provide('agentPresets',{defaultId:'test',mount:async()=>{},serviceFor:()=>undefined} as never)
    ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'test',model:'test'})} as never)
    ctx.provide('permissionPresets',{resolve:()=>{},set:()=>{}} as never)
    ctx.on('session/flush',async()=>{})
  })
  const agents=await world.plugin(Agents),sessions=await world.plugin(Sessions)
  const projections=await world.plugin(Projections),tools=await world.plugin(Tools)
  const loop=await world.plugin(AgentLoop,{})
  let native!:Awaited<ReturnType<DshNativeHost['open']>>
  const transport=await world.plugin({
    inject:['agents','sessions','agentPresets','agentDefaultModel','permissionPresets'],
    async apply(ctx:Context) {
      const lifetime=ctx.root.extend({[Context.isolate]:ctx[Context.isolate]})
      native=await new DshNativeHost(ctx,'/tmp','workspace-write','binding',undefined,undefined,'telegram',lifetime).open()
      ctx.effect(()=>()=>native.close())
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
    expect(agent.inbox.nextTurn.map(message=>message.id)).toEqual([queued.id])
    expect(agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced' && event.data.outcome==='canceled')).toBe(false)
    // Provider shutdown remains authoritative; no Agent is leaked past host stop.
    await loop.dispose()
    expect(world.agents.get(agent.id)).toBeUndefined()
    expect(agent.session.snapshotEvents().some(event=>event.type==='agent/inbox/spliced' && event.data.outcome==='canceled')).toBe(true)
  } finally {
    release.resolve()
    await transport.dispose();await loop.dispose();await tools.dispose()
    await projections.dispose();await sessions.dispose();await agents.dispose();await services.dispose()
  }
})

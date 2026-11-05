import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Agents, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Llm, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Tools from '@deepseek-ai/dsh-tools'
import { DshNativeHost } from '../src/plugin/native.js'
import { installNativeTestExecutor } from './native-sdk.js'

type Selection = {provider:string;model:string;reasoningEffort?:string}
class OfflineAdapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  override async resolveModel(provider:string,model:string) {
    return {provider,id:model,name:model,reasoning:{efforts:[{id:'high',name:'High'},{id:'low',name:'Low'}]}} as never
  }
  override async *stream(options:GenerateOptions):AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield {type:'block-start',index:0,blockType:'text'}
    yield {type:'block-end',index:0,block:{type:'text',text:'offline response'}}
    yield {type:'usage',usage:{inputTokens:1,outputTokens:1}}
    yield {type:'finish',reason:{kind:'stop'}}
  }
}
async function mount(root:string) {
  const ctx=new Context(),adapter=new OfflineAdapter()
  await ctx.plugin(Llm);await ctx.plugin(Sessions);await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt);await ctx.plugin(Tools);await installNativeTestExecutor(ctx)
  await ctx.plugin(Agents);await ctx.plugin(Jsonl,{root,compression:'none'})
  await ctx.plugin(ctx=>{
    ctx.provide('agentPresets',{defaultId:'test',mount:async()=>{},serviceFor:()=>undefined} as never)
    ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'alpha',model:'initial',reasoningEffort:'high'})} as never)
    ctx.provide('permissionPresets',{resolve:()=>{},set:()=>{}} as never)
  })
  await ctx.plugin(AgentLoop,{})
  ctx.llm.registerAdapter(['alpha','beta'],adapter)
  return {ctx,adapter,close:()=>ctx.fiber.dispose()}
}

it('restores switched models and cleared effort after real JSONL close/reopen through fresh host contexts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'channels-model-restart-'))
  let current:Awaited<ReturnType<typeof mount>>|undefined
  let id:string|undefined
  const original:Selection={provider:'alpha',model:'initial',reasoningEffort:'high'}
  const switched:Selection={provider:'beta',model:'switched',reasoningEffort:'low'}
  const cleared:Selection={provider:'beta',model:'switched'}
  async function runPlugin(expected:Selection) {
    current=await mount(root)
    // A deliberately different binding default must never replace saved state.
    const host=new DshNativeHost(current.ctx,root,'workspace-write','binding',original)
    const native=await host.open(id);id=native.id
    const operation=native.submit(crypto.randomUUID(),'offline task',()=>{})
    await operation.admitted
    expect(await operation.result).toMatchObject({reason:'completed'})
    const request=current.adapter.requests.at(-1)!
    expect({provider:request.provider,model:request.model,...request.reasoningEffort===undefined?{}:{reasoningEffort:request.reasoningEffort}}).toEqual(expected)
    await native.close();await current.close();current=undefined
  }
  async function desktopChange(selection:Selection,allowPending:boolean) {
    current=await mount(root)
    const state={current:selection,assembled:undefined}
    const handle=await current.ctx.agents.resume({resumeSessionId:id as never,agentOptions:original as never,
      setup:(ctx,agent)=>{
        const install:(ctx:Context,selectionState:typeof state)=>()=>void=installModelSelection
        install(ctx,state as never)
        if ('model' in agent) (agent.model as {select(value:Selection):void}).select(selection)
      }})
    // New SDKs durably record a pending choice before a model request; older
    // entry-point-owned state becomes durable in the next real request header.
    if (!allowPending || !('model' in handle.agent)) {
      const before=handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length
      handle.agent.followup(createUserMessage({content:[{type:'text',text:'desktop task'}],source:{kind:'user'}}))
      await vi.waitFor(()=>{
        expect(handle.agent.session.snapshotEvents().filter(e=>e.type==='turn/end').length).toBeGreaterThan(before)
        expect(handle.agent.status).toBe('idle')
      })
      expect(current.adapter.requests.at(-1)?.reasoningEffort).toBe(selection.reasoningEffort)
    } else {
      expect(current.adapter.requests).toHaveLength(0)
    }
    await current.ctx.sessions.flush(handle.agent.session)
    await handle.dispose();await current.close();current=undefined
  }
  try {
    await runPlugin(original)
    await desktopChange(switched,false)
    await runPlugin(switched)
    await desktopChange(cleared,true)
    await runPlugin(cleared)
  } finally {await current?.close();await rm(root,{recursive:true,force:true})}
},15000)

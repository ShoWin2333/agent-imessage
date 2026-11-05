import {IDENTIFIER_RE, MAX_BINDINGS} from './rules.js'
import {absoluteWorkspacePattern} from '../plugin/workspace-path.js'

/** Settings metadata only. Never add these fields to a binding's durable identity. */
export interface AgentGroup {id:string;name:string;cwd:string;bindingIds:string[]}
export const MAX_AGENTS=32
interface GroupBinding {id:string;cwd:string}

/** Retain the previous prefix + directory grouping for bindings without metadata. */
export function resolveAgentGroups(bindings:readonly GroupBinding[],agents:readonly AgentGroup[]=[]):AgentGroup[]{
  const result=agents.map(agent=>({...agent,bindingIds:[...agent.bindingIds]}))
  const assigned=new Set(result.flatMap(agent=>agent.bindingIds)),ids=new Set(result.map(agent=>agent.id))
  const inferred=new Map<string,AgentGroup>()
  for(const binding of bindings){
    if(assigned.has(binding.id))continue
    const prefix=/^(.+)-(?:imessage|telegram|weixin|qqbot)(?:-|$)/.exec(binding.id)?.[1]??''
    const key=JSON.stringify([prefix||binding.id,binding.cwd])
    let group=inferred.get(key)
    if(!group){
      const stem=`agent-${binding.id.slice(0,50)}`
      let id=stem,index=1
      while(ids.has(id))id=`${stem}-${index++}`
      ids.add(id)
      group={id,name:prefix?prefix.replace(/^./,c=>c.toUpperCase()):(binding.cwd.split(/[/\\]/).filter(Boolean).at(-1)||'Agent'),cwd:binding.cwd,bindingIds:[]}
      inferred.set(key,group);result.push(group)
    }
    group.bindingIds.push(binding.id)
  }
  return result
}

/** Native settings and the browser enforce the same metadata constraints. */
export function agentGroupIssue(bindings:readonly GroupBinding[],agents:readonly AgentGroup[]):string|undefined{
  if(agents.length>MAX_AGENTS)return 'agents-limit'
  const ids=new Set<string>(),assigned=new Set<string>(),known=new Set(bindings.map(binding=>binding.id))
  for(const agent of agents){
    if(!IDENTIFIER_RE.test(agent.id)||ids.has(agent.id))return 'agents-id'
    ids.add(agent.id)
    if(!agent.name.trim()||agent.name.length>80)return 'agents-name'
    if(!absoluteWorkspacePattern.test(agent.cwd))return 'agents-cwd'
    if(agent.bindingIds.length>MAX_BINDINGS)return 'agents-membership'
    for(const id of agent.bindingIds){
      if(!known.has(id)||assigned.has(id))return 'agents-membership'
      assigned.add(id)
    }
  }
  if(resolveAgentGroups(bindings,agents).length>MAX_AGENTS)return 'agents-limit'
  return undefined
}

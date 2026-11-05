import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BindingCommands } from './commands.js'
import type { NativePreferences } from './bridge.js'
import { ownsSession, type LegacySessionIdentity } from './identity.js'
import type { QQPresentationOptions } from './qqbot-presentation.js'
import { QQBOT_VERSION } from '../shared/qqbot-version.js'

const escapeAttribute=(s:string)=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')
export const commandLink=(command:string,label:string)=>`<qqbot-cmd-input text="${escapeAttribute(command)}" show="${escapeAttribute(label)}"/>`

export class QQCommands implements BindingCommands {
  constructor(private readonly ctx: Context, private readonly input: {
    binding: string; legacyIdentity?: LegacySessionIdentity | undefined
    model?: {provider:string;model:string} | undefined
    options: QQPresentationOptions & {streaming?:boolean}; lifetime?: Context
  }) {}
  matches(text:string) { return /^\/(new|reset|clear|compact|model|preset|bot-status|bot-help|bot-settings)(?:\s|$)/.test(text) }
  async run(text:string,scope:Parameters<BindingCommands['run']>[1]) {
    const verb=text.trim().split(/\s+/)[0]
    if(['/new','/reset','/clear'].includes(verb!)) {
      await scope.reset()
      return {text:'已开启新会话。历史会话保留。'}
    }
    if(verb==='/bot-help')return {text:'/new (/reset /clear) 新会话；/compact 压缩；/model 可点击模型列表；/preset [id]（新会话生效）；/stop；/bot-ping；/bot-version；/bot-me；/bot-status；/bot-settings 设置入口。审批与问答沿用 DSH 的单次请求凭据。'}
    if(verb==='/compact'&&scope.sessionId)await scope.resume()
    return this.command(text,scope.sessionId,scope.preferences)
  }
  private async flush(agent:Agent) {
    if(!await (this.input.lifetime??this.ctx).sessions.flush(agent.session))throw new Error('DSH session durability unavailable')
  }
  async command(text:string,sessionId:string|undefined,preferences:NativePreferences){
    const [verb,...args]=text.trim().split(/\s+/),value=args.join(' ')
    const agent=sessionId&&ownsSession(sessionId,this.input.binding,this.input.legacyIdentity)?this.ctx.agents.get(SessionId(sessionId)):undefined
    if(verb==='/bot-settings')return {text:`Messaging Channels ${QQBOT_VERSION}\nDSH → 账号菜单 → 设置 → Messaging Channels → 当前 Agent → QQ Bot 设置。\n流式输出：${this.input.options.streaming!==false?'开':'关'}；工具成功结果：${this.input.options.showToolResults?'显示':'隐藏'}；声明文件自动交付：${this.input.options.sendPresentedFiles!==false?'开（每份仍需审批）':'关'}。\n凭据状态和手动配置也在该设置页；聊天不接收密钥。`}
    if(verb==='/bot-status'){
      const events=agent?.session.snapshotEvents()??[],selection=agent?.model.current()??preferences.model??this.input.model??this.ctx.agentDefaultModel.currentSelection()
      const last=events.at(-1)
      return {text:`📊 会话状态 · ${QQBOT_VERSION}\n会话：${sessionId??'尚未创建'}\n运行：${agent?.status??'未加载'}\n模型：${selection?`${selection.provider}/${selection.model}`:'宿主默认'}\nPreset：${preferences.preset??this.ctx.agentPresets.defaultId}\n用户消息：${events.filter(e=>e.type==='user/message').length}\n最后活动：${last?new Date(last.time).toISOString():'—'}`}
    }
    if(verb==='/compact'){
      if(!agent)return {text:'当前无活跃会话。'}
      if(agent.status!=='idle')return {text:'正在生成中，无法压缩。'}
      const compaction=((this.ctx.agentPresets as unknown as {serviceFor(agent:Agent,name:string):unknown}).serviceFor(agent,'compaction')??agent.ctx.get('compaction')) as {compactNow(context:unknown,signal:AbortSignal):Promise<{shadowedSeqs:unknown[]}|null>}|undefined
      if(!compaction)return {text:'当前 Agent preset 未提供 compaction 服务。'}
      const result=await compaction.compactNow({session:agent.session,options:agent.options,runMaintenance:agent.runMaintenance.bind(agent)},new AbortController().signal)
      await this.flush(agent);return {text:`已压缩 ${result?.shadowedSeqs.length??0} 条历史记录。`}
    }
    if(verb==='/preset'){
      const presets=await this.ctx.agentPresets.list()
      if(!value)return {text:`当前：${preferences.preset??this.ctx.agentPresets.defaultId}\n${presets.map(p=>commandLink(`/preset ${p.id}`,p.id)).join('\n')}`}
      const preset=['reset','default'].includes(value)?this.ctx.agentPresets.defaultId:value
      const resolved=await this.ctx.agentPresets.resolve(preset)
      if(resolved.broken)return {text:'所选 Agent preset 不可用。'}
      return {text:`Agent preset 已选择：${preset}；新会话生效。权限审批仍使用原有配置。`,preferences:{...preferences,preset}}
    }
    if(verb!=='/model')return {text:'未知 QQ 命令。'}
    const nativeModel=agent?.model
    const selection=nativeModel?.current()??preferences.model??this.input.model??this.ctx.agentDefaultModel.currentSelection()
    if(!value){
      const providers=await this.ctx.llm.listProviders(),models=await Promise.all(providers.map(async p=>(await this.ctx.llm.listModels(p.id)).map(m=>commandLink(`/model ${p.id}/${m.id}`,m.name??`${p.id}/${m.id}`))))
      return {text:`### 模型配置\n当前：${selection?`${selection.provider}/${selection.model}`:'宿主默认'}\n可用模型（点击切换）：\n${models.flat().join('\n')}\n手动指定：/model provider/model`}
    }
    if(!value.includes('/')&&!selection)return {text:'请指定 /model provider/model。'}
    const split=value.indexOf('/'),provider=split<0?selection!.provider:value.slice(0,split),model=split<0?value:value.slice(split+1)
    if(!(await this.ctx.llm.listModels(provider)).some(m=>m.id===model))return {text:'模型不在宿主目录中。'}
    const next={provider,model}
    if(agent){agent.model.select(next);await this.flush(agent)}
    return {text:`模型已选择：${provider}/${model}；保留会话上下文。`,preferences:{...preferences,model:next}}
  }
}

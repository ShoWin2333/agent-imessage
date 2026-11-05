import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution } from '@deepseek-ai/dsh-tools'
import type { InteractionScope } from './interaction-types.js'
import type { ChannelMediaArgs, MediaSendResult } from './media-tool.js'
import { qqbotSendFileTool, qqbotDescribeImageTool, describeQQImage } from './qqbot-tools.js'
import { installQQPresentation, type QQPresentationOptions } from './qqbot-presentation.js'

/** QQ-specific tools and display composition; native host keeps session lifecycle ownership. */
export function installQQAgent(ctx: Context, agent: Agent, input: {
  cwd: string; options: QQPresentationOptions
  selection: () => {provider:string;model:string} | undefined
  scope: (agent: unknown, signal?: AbortSignal) => InteractionScope | undefined
  notice: (text:string) => void
  sendMedia: (args:ChannelMediaArgs,exec:Pick<ToolDispatchExecution,'agent'|'callId'|'signal'>) => Promise<MediaSendResult>
}) {
  const scoped = agent.ctx, tools = scoped.get('tools')
  const disposers = [installQQPresentation(scoped, agent, input.options, {
    current: () => !!input.scope(agent), notice: input.notice,
  })]
  if (tools) {
    disposers.push(tools.register(qqbotSendFileTool(input.sendMedia)))
    disposers.push(tools.register(qqbotDescribeImageTool(async (image, prompt, exec) => {
      const scope = input.scope(exec.agent, exec.signal)
      if (!scope) throw new Error('Image analysis requires an active channel turn')
      const signal = AbortSignal.any([scope.signal, AbortSignal.timeout(120_000)])
      const selection = input.selection()
      if (!selection) throw new Error('A vision model must be configured')
      const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
      if (info.inputModalities && !info.inputModalities.includes('image')) throw new Error('Selected model does not accept images; configure QQ visionProvider and visionModel')
      const reader = ctx.agentPresets.serviceFor(agent, 'fs') ?? scoped.get('fs')
      const attachments = scoped.get('attachments') as Parameters<typeof describeQQImage>[0]['attachments'] | undefined
      if (!reader || !attachments) throw new Error('Agent preset must provide filesystem and image attachment services')
      return describeQQImage({image,prompt,cwd:input.cwd,reader,signal,attachments,llm:ctx.llm,...selection})
    })))
  }
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}

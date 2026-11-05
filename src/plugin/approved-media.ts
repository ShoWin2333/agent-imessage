import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ChannelMediaArgs } from './media-tool.js'
import type { InteractionScope } from './interaction-types.js'
import type { MediaHandler } from './media-delivery.js'
import { loadOutboundMedia, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES } from '../media.js'
import { prepareVoiceMedia } from './audio-preparation.js'

/** All explicit and presented-file uploads use the same approval/read/commit order. */
export async function sendApprovedMedia(ctx: Context, input: {
  agent: Agent; cwd: string; args: ChannelMediaArgs; callId: string
  scope: InteractionScope; deliver: MediaHandler; flush: () => Promise<void>; channelKind?: string | undefined
}) {
  const { agent, args, scope } = input
  const ensureCurrent = () => {
    if (!scope.current() || scope.signal.aborted) throw new Error('Media send cancelled or channel turn ended.')
  }
  ensureCurrent()
  const approval = ctx.get('approval')
  if (!approval) throw new Error('Media upload approval is unavailable.')
  const reason = `Upload ${args.kind} file ${args.path} to this channel's configured recipient.`
  const mediaKind = { image: '图片', file: '文件', voice: '语音' }[args.kind]
  const outcome = await approval.request({ agent, toolName: 'channel_send_media', callId: input.callId as ToolRunContext['callId'], reason,
    displayReason: { en: reason, zh: `将工作区中的${mediaKind}「${args.path}」发送到当前渠道。` }, signal: scope.signal })
  if (outcome !== 'allowed-once') throw new Error('Media upload was not approved.')
  ensureCurrent()
  const reader = ctx.agentPresets.serviceFor(agent, 'fs') ?? agent.ctx.get('fs')
  if (!reader) throw new Error('The channel Agent has no filesystem provider for media reads.')
  let media = await loadOutboundMedia({ rawPath: args.path, kind: args.kind === 'voice' ? 'audio' : args.kind,
    workspaceCwd: input.cwd, maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, signal: scope.signal, reader })
  ensureCurrent()
  let preparationNote: string | undefined
  if (args.kind === 'voice' && input.channelKind === 'telegram') {
    const presets = ctx.agentPresets
    const policy = presets.serviceFor(agent, 'sandboxPolicy')?.resolve({ session: agent.session })
    const subprocess = presets.serviceFor(agent, 'subprocess'), sandbox = presets.serviceFor(agent, 'sandbox')
    const prepared = await prepareVoiceMedia(media, {
      ...(subprocess ? { subprocess } : {}), ...(sandbox ? { sandbox } : {}),
      ...(policy ? { policy } : {}), cwd: input.cwd,
    }, scope.signal)
    media = prepared.media
    if (prepared.status === 'unavailable') preparationNote = prepared.note
    ensureCurrent()
  }
  await input.flush()
  ensureCurrent()
  const result = await input.deliver({ ...scope, callId: input.callId, kind: args.kind, media })
  return preparationNote && result.mode === 'file' ? { ...result, reason: preparationNote } : result
}

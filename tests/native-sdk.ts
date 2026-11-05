import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** DSH 0.2.2 splits native execution from the tool registry. */
export async function installNativeTestExecutor(ctx: Context): Promise<{ dispose(): Promise<void> }> {
  if (!('setExecutor' in ctx.tools)) return { dispose: async () => {} }
  // Installed by the target-SDK test environment; absent from the 0.2.1 SDK.
  const packageName = '@deepseek-ai/dsh-tool-executor-native'
  return ctx.plugin(await import(/* @vite-ignore */ packageName))
}

/** Keep the real SDK pipeline under test despite its single-call → batch API change. */
export async function executeTestTool(ctx: Context, input: {
  agent: Agent; callId: string; name: string; arguments: unknown; signal: AbortSignal
}): Promise<ToolExecutionResult> {
  if (!('setExecutor' in ctx.tools)) return ctx.tools.execute(input as never)
  const batch = await ctx.tools.execute({ agent: input.agent, signal: input.signal,
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }] } as never)
  return (batch as unknown as { results: Array<{ result: ToolExecutionResult }> }).results[0]!.result
}

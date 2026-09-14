import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { foldRequestHeader, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

/** Reconstruct the preset using DSH's header-plus-last-selection convention. */
export function presetForResume(
  header: SessionHeader,
  events: readonly SessionEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return header.agentPreset
}

/** Select the last persisted request model, falling back to today's default. */
export function selectionForResume(
  events: readonly SessionEvent[],
  fallback: ModelSelection,
): ModelSelection {
  const config = foldRequestHeader(events)?.config
  return config === undefined
    ? fallback
    : {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    }
}

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BindingStatus } from './management.js'

export interface ChannelStatusSource {
  /** Current lifecycle state for every configured binding, in configuration order. */
  readonly status: () => { bindings: BindingStatus[]; configError?: string }
  /** Binding ids the Host is currently trying to keep connected. */
  readonly enabled: () => ReadonlySet<string>
}

/**
 * Read-only visibility for the model: which channels exist, whether each is
 * enabled, and how its transport is doing. Message content, credentials and
 * session identifiers stay out of the result.
 */
export function channelStatusTool(source: ChannelStatusSource) {
  return defineTool({
    name: 'channel_status',
    description: 'List the configured message channels with their enabled flag and live connection phase. Read-only; returns no message content, credentials or session data.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bindings: {
            type: 'array',
            description: 'One entry per configured channel, in configuration order.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', description: 'Binding id from the channel configuration.', required: true },
                enabled: { type: 'boolean', description: 'Whether the Host is keeping this channel connected.', required: true },
                phase: { type: 'string', description: 'Transport phase such as listening, retrying or failed.', required: true },
                error: { type: 'string', description: 'Stable error code when the channel failed or stopped incompletely.' },
              },
            },
          },
          configError: { type: 'string', description: 'Set when the saved channel configuration itself is invalid.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => {
      const { bindings, configError } = source.status()
      const enabled = source.enabled()
      return {
        bindings: bindings.map(({ id, phase, error }) => ({
          id, enabled: enabled.has(id), phase,
          ...(error === undefined ? {} : { error }),
        })),
        ...(configError === undefined ? {} : { configError }),
      }
    },
  })
}

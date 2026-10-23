import { expect, it } from 'vitest'
import { channelStatusTool } from '../src/plugin/tool.js'

it('exposes read-only channel state without message or credential data', async () => {
  const tool = channelStatusTool({
    status: () => ({
      bindings: [{ id: 'telegram-a', phase: 'listening' }, { id: 'telegram-b', phase: 'error', error: 'credential-missing' }],
      configError: 'config-invalid',
    }),
    enabled: () => new Set(['telegram-a']),
  })
  expect(tool.name).toBe('channel_status')
  const value = await tool.execute({}, {} as never)
  expect(value).toEqual({
    bindings: [
      { id: 'telegram-a', enabled: true, phase: 'listening' },
      { id: 'telegram-b', enabled: false, phase: 'error', error: 'credential-missing' },
    ],
    configError: 'config-invalid',
  })
  expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }])
  const schema = JSON.stringify(tool.output.schema)
  expect(schema).not.toContain('token')
  expect(schema).not.toContain('secret')
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorServer } from '../src/cursor/rpc.js'
import { CodexRouter } from '../src/codex/router.js'
import type { Rpc, ObjectValue } from '../src/codex/rpc.js'
import type { RouteState } from '../src/codex/state.js'

const route = { id: 'cursor', cwd: '/workspace', backend: 'cursor' as const, projectId: 'p', projectSecretEnv: 'SECRET', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }
const cleanup: Array<() => void> = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.useRealTimers() })
class Wire implements Rpc {
  onNotification: Rpc['onNotification'] = () => {}
  onRequest: Rpc['onRequest'] = async () => ({})
  onClose = () => {}
  close = vi.fn(() => this.onClose())
  notify = vi.fn()
  finish: (value: ObjectValue) => void = () => {}
  reject: (error: Error) => void = () => {}
  request = vi.fn(async (method: string, _params: ObjectValue): Promise<ObjectValue> => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (method === 'session/new' || method === 'session/load') return { sessionId: 's1', modes: { currentModeId: 'agent', availableModes: [{ id: 'agent' }, { id: 'ask' }] } }
    if (method === 'session/prompt') return new Promise((resolve, reject) => { this.finish = resolve; this.reject = reject })
    return {}
  })
}
async function setup(threadId?: string) {
  const wire = new Wire()
  const rpc = new CursorServer(wire, route)
  const store = { state: { seen: [], ...(threadId ? { threadId } : {}) } as RouteState, save: vi.fn(async () => {}) }
  const router = new CodexRouter(rpc, route, store, 50)
  cleanup.push(() => router.close())
  router.setConnected(true)
  await rpc.initialize()
  let id = 0
  const send = vi.fn(async (_text: string) => {})
  const message = (text: string) => ({ id: String(++id), text, send, sendFile: vi.fn(), sendVoice: vi.fn(), responding: async (fn: () => Promise<unknown>) => fn() })
  const settle = async () => new Promise(resolve => setImmediate(resolve))
  const permission = () => wire.onRequest('session/request_permission', { sessionId: 's1', toolCall: { title: 'Run echo `hello`', rawInput: { command: 'echo `hello`' } }, options: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] })
  return { wire, rpc, router, store, send, message, settle, permission }
}

describe('Cursor ACP integration', () => {
  it('authenticates, starts once, suppresses reasoning, and delivers text after completion', async () => {
    const s = await setup()
    expect(s.wire.request).toHaveBeenCalledWith('authenticate', { methodId: 'cursor_login' })
    await s.router.receive(s.message('hello'))
    await s.router.receive(s.message('busy'))
    expect(s.wire.request.mock.calls.filter(([m]) => m === 'session/prompt')).toHaveLength(1)
    for (const [sessionId, sessionUpdate, text] of [['wrong', 'agent_message_chunk', 'foreign'], ['s1', 'agent_thought_chunk', 'private'], ['s1', 'agent_message_chunk', 'Hello '], ['s1', 'agent_message_chunk', 'world']]) {
      s.wire.onNotification('session/update', { sessionId, update: { sessionUpdate, content: { type: 'text', text } } })
    }
    expect(s.send).not.toHaveBeenCalledWith('Hello world')
    s.wire.finish({ stopReason: 'end_turn' }); await s.settle()
    expect(s.send).toHaveBeenCalledWith('Hello world')
    expect(s.send.mock.calls.flat().join()).not.toMatch(/foreign|private|Codex/)
  })
  it('resumes saved sessions without forwarding replay and creates fresh sessions after /new', async () => {
    const s = await setup('s1')
    await s.router.receive(s.message('continue'))
    expect(s.wire.request).toHaveBeenCalledWith('session/load', { sessionId: 's1', cwd: '/workspace', mcpServers: [] })
    s.wire.finish({ stopReason: 'end_turn' }); await s.settle()
    await s.router.receive(s.message('/new')); await s.router.receive(s.message('new'))
    expect(s.wire.request).toHaveBeenCalledWith('session/new', { cwd: '/workspace', mcpServers: [] })
  })
  it.each([['approve', 'yes'], ['deny', 'no']])('maps /%s to the offered single-use option', async (command, optionId) => {
    const s = await setup(); await s.router.receive(s.message('task'))
    const result = s.permission(); await s.settle()
    const prompt = s.send.mock.calls.flat().find(t => t.includes('/approve'))!
    expect(prompt).toContain('echo `hello`')
    const id = prompt.match(/\/approve (\S+)/)![1]
    await s.router.receive(s.message(`/${command} ${id}`))
    await expect(result).resolves.toEqual({ outcome: { outcome: 'selected', optionId } })
  })
  it('cancels pending permissions and sends a notification on /stop', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    const pending = s.permission(); await s.settle()
    await s.router.receive(s.message('/stop'))
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(s.wire.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 's1' })
    s.wire.finish({ stopReason: 'cancelled' }); await s.settle()
    expect(s.send).toHaveBeenCalledWith('Task stopped.')
  })
  it('fails closed for unknown requests, foreign sessions, broad-only and oversized approvals', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    await expect(s.wire.onRequest('fs/write_text_file', {})).rejects.toThrow('Unsupported')
    await expect(s.wire.onRequest('session/request_permission', { sessionId: 'foreign' })).rejects.toThrow('Unowned')
    for (const options of [[{ kind: 'allow_always', optionId: 'always' }], [{ kind: 'allow_once', optionId: 'yes' }]]) {
      await expect(s.wire.onRequest('session/request_permission', { sessionId: 's1', toolCall: { title: 'x'.repeat(3000), rawInput: { command: 'echo hi' } }, options })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    }
  })
  it('closes an unresponsive process ten seconds after cancellation', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    vi.useFakeTimers()
    await s.router.receive(s.message('/stop'))
    await vi.advanceTimersByTimeAsync(10_001)
    expect(s.wire.close).toHaveBeenCalledOnce()
  })
  it('cancels permissions on expiry and disconnect without granting access', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    vi.useFakeTimers()
    const expired = s.permission()
    await vi.advanceTimersByTimeAsync(51)
    await expect(expired).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    const disconnected = s.permission()
    await vi.advanceTimersByTimeAsync(0)
    s.router.setConnected(false)
    await expect(disconnected).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(s.wire.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 's1' })
  })
  it('maps Cursor single-choice questions and plan approval', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    const question = s.wire.onRequest('cursor/ask_question', { questions: [{ id: 'color', prompt: 'Color?', options: [{ id: 'blue', label: 'Blue' }] }] })
    await s.settle()
    const prompt = s.send.mock.calls.flat().find(t => t.includes('Input requested'))!
    await s.router.receive(s.message(`/answer ${prompt.match(/\/answer (\S+)/)![1]} {"color":"blue"}`))
    await expect(question).resolves.toEqual({ outcome: { outcome: 'answered', answers: [{ questionId: 'color', selectedOptionIds: ['blue'] }] } })
    const plan = s.wire.onRequest('cursor/create_plan', { name: 'Plan', plan: 'Create a test.' }); await s.settle()
    const approval = s.send.mock.calls.flat().find(t => t.includes('/approve'))!
    await s.router.receive(s.message(`/deny ${approval.match(/\/approve (\S+)/)![1]}`))
    await expect(plan).resolves.toEqual({ outcome: { outcome: 'rejected' } })
  })
  it('reports backend failure and ignores output after completion', async () => {
    const s = await setup(); await s.router.receive(s.message('task'))
    s.wire.reject(new Error('secret internal error')); await s.settle()
    s.wire.onNotification('session/update', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } })
    expect(s.send.mock.calls.flat().join()).toContain('Cursor could not complete')
    expect(s.send.mock.calls.flat().join()).not.toMatch(/secret|late/)
  })
  it('selects a supported mode and refuses unsupported resume', async () => {
    const wire = new Wire(); const rpc = new CursorServer(wire, { ...route, cursorMode: 'ask' }); cleanup.push(() => rpc.close())
    await rpc.initialize(); await rpc.request('thread/start', { cwd: '/workspace' })
    expect(wire.request).toHaveBeenCalledWith('session/set_mode', { sessionId: 's1', modeId: 'ask' })
    const unavailable = new Wire(); unavailable.request.mockResolvedValue({ protocolVersion: 1 })
    const other = new CursorServer(unavailable, route); cleanup.push(() => other.close())
    await other.initialize()
    await expect(other.request('thread/resume', { cwd: '/workspace', threadId: 'saved' })).rejects.toThrow('resume unavailable')
  })
})

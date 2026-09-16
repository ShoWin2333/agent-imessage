import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRouter } from '../src/codex/router.js'
import type { Rpc, ObjectValue } from '../src/codex/rpc.js'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'
import type { RouteState } from '../src/codex/state.js'

const directories: string[] = []
const routers: CodexRouter[] = []
afterEach(async () => { routers.splice(0).forEach(r => r.close()); vi.useRealTimers(); await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
class FakeRpc implements Rpc {
  onNotification: Rpc['onNotification'] = () => {}
  onRequest: Rpc['onRequest'] = async () => ({})
  onClose = () => {}
  close = vi.fn()
  count = 0
  cwd = '/workspace'
  request = vi.fn(async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId ?? 'thread-1', cwd: this.cwd } }
    if (method === 'turn/start') {
      const id = `turn-${++this.count}`
      this.onNotification('turn/started', { threadId: 'thread-1', turn: { id } })
      return { turn: { id } }
    }
    return {}
  })
}
function setup(cwd = '/workspace', threadId?: string) {
  const rpc = new FakeRpc(); rpc.cwd = cwd
  const store = { state: { seen: [], ...(threadId ? { threadId } : {}) } as RouteState, save: vi.fn(async () => {}) }
  const router = new CodexRouter(rpc, { id: 'one', cwd, projectId: 'p', projectSecretEnv: 'SECRET', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }, store, 1000)
  router.setConnected(true); routers.push(router)
  const send = vi.fn(async (_text: string) => {})
  const sendFile = vi.fn(async () => {})
  const sendVoice = vi.fn(async () => {})
  let sequence = 0
  const message = (text: string, id = String(++sequence)): SpectrumInboundMessage => ({ id, text, send, sendFile, sendVoice, responding: async fn => fn() })
  const owned = { threadId: 'thread-1', turnId: 'turn-1' }
  const settle = async () => { await new Promise(resolve => setImmediate(resolve)) }
  return { rpc, router, store, message, send, sendFile, sendVoice, owned, settle }
}

describe('Codex route ownership and lifecycle', () => {
  it('starts a sandboxed thread, rejects duplicate/busy prompts, returns only final output', async () => {
    const s = setup()
    await s.router.receive(s.message('hello', 'first'))
    await s.router.receive(s.message('hello', 'first'))
    await s.router.receive(s.message('another'))
    expect(s.rpc.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    expect(s.rpc.request).toHaveBeenCalledWith('thread/start', expect.objectContaining({ cwd: '/workspace', sandbox: 'workspace-write', approvalPolicy: 'untrusted' }))
    s.rpc.onNotification('item/completed', { ...s.owned, item: { type: 'agentMessage', id: 'a', phase: 'commentary', text: 'private intermediate' } })
    s.rpc.onNotification('item/completed', { ...s.owned, turnId: 'foreign', item: { type: 'agentMessage', id: 'b', text: 'foreign' } })
    s.rpc.onNotification('item/completed', { ...s.owned, item: { type: 'agentMessage', id: 'c', phase: 'final_answer', text: 'Finished!' } })
    s.rpc.onNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await s.settle()
    expect(s.send).toHaveBeenCalledWith('Finished!')
    expect(s.send.mock.calls.flat().join()).not.toContain('private intermediate')
    expect(s.send.mock.calls.flat().join()).not.toContain('foreign')
  })
  it('resumes only the persisted thread and refuses a mismatched workspace', async () => {
    const s = setup('/workspace', 'saved')
    s.rpc.cwd = '/different'
    await s.router.receive(s.message('hello'))
    expect(s.rpc.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'saved' }))
    expect(s.rpc.request.mock.calls.some(([m]) => m === 'turn/start')).toBe(false)
    expect(s.rpc.close).toHaveBeenCalled()
  })
  it('scopes approvals to a route and expires them after stop', async () => {
    const s = setup()
    await s.router.receive(s.message('task'))
    await expect(s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, threadId: 'foreign', command: 'echo hi' })).rejects.toThrow('Unowned')
    const pending = s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'echo hi' })
    await s.settle()
    const prompt = s.send.mock.calls.map(x => x[0]).find(x => x.includes('/approve'))!
    const id = prompt.match(/\/approve ([a-f0-9-]+)/)![1]!
    await s.router.receive(s.message(`/approve ${id}`))
    await expect(pending).resolves.toEqual({ decision: 'accept' })
    const second = s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'echo again' })
    await s.settle()
    await s.router.receive(s.message('/stop'))
    await expect(second).resolves.toEqual({ decision: 'cancel' })
    expect(s.rpc.request).toHaveBeenCalledWith('turn/interrupt', s.owned)
  })
  it('denies oversized or undisplayable approvals and unsupported permission requests', async () => {
    const s = setup(); await s.router.receive(s.message('task'))
    await expect(s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'x'.repeat(10000) })).rejects.toThrow('too large')
    await expect(s.rpc.onRequest('item/fileChange/requestApproval', { ...s.owned, itemId: 'no-diff' })).rejects.toThrow('unavailable')
    await expect(s.rpc.onRequest('item/permissions/requestApproval', s.owned)).rejects.toThrow('Unsupported')
    await expect(s.rpc.onRequest('item/fileChange/requestApproval', { ...s.owned, grantRoot: '/etc' })).rejects.toThrow('Session-wide')
  })
  it('cancels pending approval when delivery disconnects', async () => {
    const s = setup(); await s.router.receive(s.message('task'))
    const pending = s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'echo hi' })
    await s.settle(); s.router.setConnected(false)
    await expect(pending).resolves.toEqual({ decision: 'cancel' })
    expect(s.rpc.request).toHaveBeenCalledWith('turn/interrupt', s.owned)
  })
  it('displays command syntax unchanged and rejects approvals from another route', async () => {
    const s = setup(); await s.router.receive(s.message('task'))
    const pending = s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'echo `whoami` && echo $HOME' })
    await s.settle()
    const prompt = s.send.mock.calls.map(x => x[0]).find(x => x.includes('/approve'))!
    expect(prompt).toContain('echo `whoami` && echo $HOME')
    const id = prompt.match(/\/approve ([a-f0-9-]+)/)![1]!
    const other = setup(); await other.router.receive(other.message(`/approve ${id}`))
    expect(other.send).toHaveBeenCalledWith('Request expired or does not belong to this route.')
    await s.router.receive(s.message(`/deny ${id}`))
    await expect(pending).resolves.toEqual({ decision: 'decline' })
  })
  it('times out approvals without accepting', async () => {
    const s = setup(); await s.router.receive(s.message('task'))
    vi.useFakeTimers()
    const pending = s.rpc.onRequest('item/commandExecution/requestApproval', { ...s.owned, command: 'echo hi' })
    await vi.advanceTimersByTimeAsync(1001)
    await expect(pending).resolves.toEqual({ decision: 'cancel' })
  })
  it('maps explicit question IDs and rejects secret questions', async () => {
    const s = setup(); await s.router.receive(s.message('task'))
    await expect(s.rpc.onRequest('item/tool/requestUserInput', { ...s.owned, questions: [{ id: 'q', question: 'Password?', isSecret: true }] })).rejects.toThrow()
    const pending = s.rpc.onRequest('item/tool/requestUserInput', { ...s.owned, questions: [{ id: 'q', question: 'Which?', options: [{ label: 'One' }] }] })
    await s.settle()
    const id = s.send.mock.calls.map(x => x[0]).find(x => x.includes('/answer') && x.includes('Input requested'))!.match(/\/answer ([a-f0-9-]+)/)![1]!
    await s.router.receive(s.message(`/answer ${id} {"q":"One"}`))
    await expect(pending).resolves.toEqual({ answers: { q: { answers: ['One'] } } })
  })
  it('sends in-workspace media and rejects symlink escapes and stale turns', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'agent-media-')); directories.push(temp)
    const cwd = await realpath(temp)
    await writeFile(join(cwd, 'hello.txt'), 'hello')
    await symlink('/etc/hosts', join(cwd, 'outside'))
    const s = setup(cwd); await s.router.receive(s.message('send file'))
    const call = { ...s.owned, tool: 'send_imessage_file', arguments: { path: 'hello.txt' } }
    await expect(s.rpc.onRequest('item/tool/call', call)).resolves.toMatchObject({ success: true })
    expect(s.sendFile).toHaveBeenCalledOnce()
    await expect(s.rpc.onRequest('item/tool/call', { ...call, arguments: { path: 'outside' } })).resolves.toMatchObject({ success: false })
    await s.router.receive(s.message('/stop'))
    await expect(s.rpc.onRequest('item/tool/call', call)).rejects.toThrow()
    expect(s.sendFile).toHaveBeenCalledOnce()
  })
})

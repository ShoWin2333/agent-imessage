// Explicit opt-in live test: uses the local Codex account, but no Photon service or real recipient.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServer } from '../lib/types/codex/rpc.js'
import { CodexRouter } from '../lib/types/codex/router.js'

const temporary = await mkdtemp(join(tmpdir(), 'agent-codex-live-'))
const cwd = await realpath(temporary)
await writeFile(join(cwd, 'hello.txt'), 'Agent iMessage smoke fixture\n')
const rpc = new AppServer(process.env.CODEX_BIN ?? 'codex', cwd)
const store = { state: { seen: [] }, save: async () => {} }
const router = new CodexRouter(rpc, { id: 'smoke', cwd, projectId: 'fake', projectSecretEnv: 'UNUSED', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }, store)
router.setConnected(true)
let finish
const completed = new Promise(resolve => { finish = resolve })
const handleNotification = rpc.onNotification
rpc.onNotification = (method, params) => {
  handleNotification(method, params)
  if (method === 'turn/completed') setImmediate(() => finish(false))
}
const sent = []
let fileCount = 0
const timer = setTimeout(() => finish(false), 120_000)
try {
  await rpc.initialize()
  await router.receive({
    id: 'live-smoke-1',
    text: 'Please send me hello.txt from this workspace using send_imessage_file. Do not run shell commands or modify any files. Only after the send succeeds, reply with exactly BRIDGE_SMOKE_OK. If the tool is unavailable or fails, explain the failure instead.',
    send: async text => { sent.push(text); if (text.trim() === 'BRIDGE_SMOKE_OK') finish(true) },
    sendFile: async media => { assert.equal(media.name, 'hello.txt'); assert.equal(media.bytes.toString(), 'Agent iMessage smoke fixture\n'); fileCount++ },
    sendVoice: async () => { throw new Error('Unexpected voice tool') },
    responding: async fn => fn(),
  })
  assert.equal(await completed, true, 'No successful final answer received within 120 seconds')
  if (fileCount !== 1) console.error('Smoke responses:', JSON.stringify(sent))
  assert.equal(fileCount, 1, 'Expected one dynamic media tool call')
  assert.ok(store.state.threadId)
  console.log('PASS: real Codex thread/turn, dynamic file tool, and final-answer delivery to a fake iMessage transport.')
} finally {
  clearTimeout(timer)
  if (store.state.threadId) await rpc.request('thread/archive', { threadId: store.state.threadId }).catch(() => {})
  router.close()
  await rm(temporary, { recursive: true, force: true })
}

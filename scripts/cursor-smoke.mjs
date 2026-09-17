// Real SDK + workspace + shared Gateway; no real recipient. See README for phone acceptance.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IsolatedCursorBackend } from '../lib/types/backends/isolated-cursor.js'
import { GatewayRouter } from '../lib/types/gateway/router.js'
const apiKey = process.env.CURSOR_API_KEY || (process.env.CURSOR_API_KEY_FILE ? (await readFile(process.env.CURSOR_API_KEY_FILE, 'utf8')).trim() : '')
assert.ok(apiKey, 'Set CURSOR_API_KEY or CURSOR_API_KEY_FILE')
const cwd = await realpath(await mkdtemp(join(tmpdir(), 'agent-cursor-live-')))
await writeFile(join(cwd, 'hello.txt'), 'GATEWAY_FIXTURE_6421\n')
const route = { id:'smoke',cwd,backend:'cursor',model:process.env.CURSOR_MODEL || 'composer-2.5',projectId:'fixture',projectSecretEnv:'PHOTON_SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321' }
const backend = new IsolatedCursorBackend(route, apiKey, ['CURSOR_API_KEY_FILE','CURSOR_API_KEY','PHOTON_SECRET'])
const store = { state:{seen:[]}, save:async()=>{} }
const router = new GatewayRouter(backend, route, store)
router.setConnected(true)
let finish
const done = new Promise(resolve => { finish = resolve })
let sentFile = false
const timer = setTimeout(() => finish(false), 180_000)
try {
  await backend.initialize()
  await router.receive({
    id:'smoke-1',text:'Read hello.txt in this workspace. Send it using send_imessage_file, then reply exactly GATEWAY_OK GATEWAY_FIXTURE_6421. Do not modify files or run shell commands.',
    send:async text => { console.log('Gateway reply:', text.slice(0, 500)); if (text.includes('GATEWAY_OK GATEWAY_FIXTURE_6421')) finish(true); if (text.includes('could not complete') || text.includes('stopped after an error')) finish(false) },
    sendFile:async media => { assert.equal(media.name,'hello.txt');assert.equal(media.bytes.toString(),'GATEWAY_FIXTURE_6421\n');sentFile=true },
    sendVoice:async()=>{throw new Error('Unexpected voice')},responding:fn=>fn(),
  })
  assert.equal(await done,true,'SDK task did not complete successfully')
  assert.equal(sentFile,true,'Shared file tool was not called')
  console.log('PASS: real Cursor SDK → sandboxed local workspace → shared media → Gateway reply (fake recipient).')
} finally { clearTimeout(timer); await router.close(); await rm(cwd,{recursive:true,force:true}) }

import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppServer, JsonRpcProcess } from '../src/codex/rpc.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
it('handles stdio notifications, server requests, secret omission, and process closure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-rpc-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, 'fake-codex')
  await writeFile(binary, `#!/usr/bin/env node
const {createInterface} = require('node:readline');
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const x=JSON.parse(line);
 if(x.method==='initialize') send({id:x.id,result:{}});
 else if(x.method==='exercise') {
  send({method:'notice',params:{ok:true}});
  send({id:'server-1',method:'item/tool/call',params:{tool:'test'}});
  send({id:x.id,result:{secretPresent:!!process.env.AGENT_RPC_TEST_SECRET}});
 } else if(x.id==='server-1') send({method:'answered',params:{response:x.result}});
 else if(x.method==='exit') process.exit(0);
});\n`, { mode: 0o700 })
  process.env.AGENT_RPC_TEST_SECRET = 'temporary-fixture'
  const rpc = new AppServer(binary, dir, ['AGENT_RPC_TEST_SECRET'])
  delete process.env.AGENT_RPC_TEST_SECRET
  cleanup.push(async () => rpc.close())
  const events: unknown[] = []
  rpc.onNotification = (method, params) => events.push([method, params])
  rpc.onRequest = async (_method, params) => ({ success: params.tool === 'test' })
  await rpc.initialize()
  expect(await rpc.request('exercise', {})).toEqual({ secretPresent: false })
  await expect.poll(() => events).toContainEqual(['answered', { response: { success: true } }])
  expect(events).toContainEqual(['notice', { ok: true }])
  await expect(rpc.request('exit', {})).rejects.toThrow('closed')
})

it('uses ACP JSON-RPC envelopes, acp arguments and notification cancellation without leaking Photon secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-acp-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, 'fake-cursor')
  await writeFile(binary, `#!/usr/bin/env node
const {createInterface} = require('node:readline');
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
createInterface({input:process.stdin}).on('line', line => {
 const x=JSON.parse(line);
 if(x.jsonrpc!=='2.0') process.exit(2);
 if(x.method==='initialize') send({id:x.id,result:{args:process.argv.slice(2),secretPresent:!!process.env.ACP_PHOTON_FIXTURE}});
 else if(x.method==='session/cancel') send({method:'cancelled',params:{notification:x.id===undefined,sessionId:x.params.sessionId}});
});\n`, { mode: 0o700 })
  process.env.ACP_PHOTON_FIXTURE = 'fixture'
  const rpc = new JsonRpcProcess(binary, dir, ['ACP_PHOTON_FIXTURE'], { args: ['acp'], jsonrpc: true })
  delete process.env.ACP_PHOTON_FIXTURE
  cleanup.push(async () => rpc.close())
  const events: unknown[] = []
  rpc.onNotification = (method, params) => events.push([method, params])
  expect(await rpc.request('initialize', {})).toEqual({ args: ['acp'], secretPresent: false })
  rpc.notify('session/cancel', { sessionId: 's1' })
  await expect.poll(() => events).toContainEqual(['cancelled', { notification: true, sessionId: 's1' }])
})

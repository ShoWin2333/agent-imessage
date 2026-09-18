// Opt-in UI/lifecycle test: use a dedicated app identity, never the live gateway.
import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises'
import {tmpdir, homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {createServer} from 'node:net'
const exec = promisify(execFile)
const app = resolve(process.argv[2] ?? '')
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-',join(app,'Contents/Info.plist')], {encoding:'utf8'}))
assert.equal(info.GatewayStandalone, true)
assert.match(info.CFBundleIdentifier, /\.standalone-test$/)
assert.match(info.GatewayServiceLabel, /\.standalone-test\.gateway$/)
const label = info.GatewayServiceLabel, target = `gui/${process.getuid()}/${label}`
const dir = await mkdtemp(join(tmpdir(),'gateway-native-test-'))
const config = join(dir, 'config.json')
const listener = createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
await writeFile(config, JSON.stringify({port, stateDir:join(dir,'state'), routes:[]}), {mode:0o600})
const runtimePlist = join(homedir(),'Library/Application Support/Agent iMessage/Desktop',`${label}.plist`)
try {
  const launched = exec('/usr/bin/open', ['-n','-W','--env',`AGENT_GATEWAY_CONFIG=${config}`,app,'--args','--smoke-close'], {timeout:30000})
  let ready = false
  for (let i=0;i<40;i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/`, {signal:AbortSignal.timeout(500)})).status === 200 } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  assert.equal(ready, true, 'Native app starts bundled server on configured port')
  const job = JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',runtimePlist],{encoding:'utf8'}))
  assert.equal(job.ProgramArguments[0], join(app,'Contents/Helpers/node'))
  assert.equal(job.ProgramArguments[3], config)
  await launched
  const state = JSON.parse(await readFile(config,'utf8'))
  assert.equal(state.port, port)
  let stopped = false
  try {execFileSync('/bin/launchctl',['print',target],{stdio:'ignore'})} catch {stopped=true}
  assert.equal(stopped,true,'Quit unloads the owned job')
  console.log('PASS: native launch, runtime config/paths, close/reopen and owned-service shutdown.')
} finally {
  try {execFileSync('/bin/launchctl',['bootout',target],{stdio:'ignore'})} catch {}
  await rm(runtimePlist,{force:true})
  await rm(dir,{recursive:true,force:true})
}

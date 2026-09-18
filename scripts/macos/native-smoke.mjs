// Opt-in UI/lifecycle tests: dedicated identity, empty config, no real channels.
import assert from 'node:assert/strict'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp, writeFile, readFile, rm, cp} from 'node:fs/promises'
import {tmpdir, homedir} from 'node:os'
import {join, resolve} from 'node:path'
import {createServer} from 'node:net'
const exec = promisify(execFile)
if (!process.argv[2]) throw new Error('Provide a dedicated standalone test .app')
const original = resolve(process.argv[2])
const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert','json','-o','-',join(original,'Contents/Info.plist')], {encoding:'utf8'}))
assert.equal(info.GatewayStandalone, true)
assert.match(info.CFBundleIdentifier, /\.standalone-test$/)
assert.match(info.GatewayServiceLabel, /\.standalone-test\.gateway$/)
const label = info.GatewayServiceLabel, baseTarget = `gui/${process.getuid()}/${label}`
const dir = await mkdtemp(join(tmpdir(),'gateway-native-test-'))
const config = join(dir,'config.json'), report = join(dir,'report.json')
const runtime = join(homedir(),'Library/Application Support/Agent iMessage/Desktop')
const receipt = join(runtime,`${label}.owner.json`)
const cleanup = new Set([baseTarget])
const appPids = new Set()
let direct
const listener = createServer()
await new Promise(resolve => listener.listen(0,'127.0.0.1',resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
await writeFile(config,JSON.stringify({port,stateDir:join(dir,'state'),routes:[]}),{mode:0o600})
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
const running = target => {try {execFileSync('/bin/launchctl',['print',target],{stdio:'ignore'});return true}catch{return false}}
async function events() {try{return JSON.parse(await readFile(report,'utf8'))}catch{return []}}
async function waitFor(fn, description) {
  for (let i=0;i<150;i++) {const result=await fn();if(result)return result;await delay(100)}
  throw new Error('Timed out: '+description)
}
async function launch(app, mode='--smoke-close') {
  await rm(report,{force:true})
  await exec('/usr/bin/open',['-n','--env',`AGENT_GATEWAY_CONFIG=${config}`,'--env',`AGENT_GATEWAY_SMOKE_REPORT=${report}`,app,'--args',mode])
  const launched = await waitFor(async()=> (await events()).find(e=>e.event==='launched'), 'launch report')
  appPids.add(launched.pid)
  const event = await waitFor(async()=> (await events()).find(e=>e.event===(mode==='--smoke-quit-start'?'quitting':'ready')), 'app ready')
  appPids.add(event.pid)
  if(event.owned) cleanup.add(event.target)
  return event
}
async function finished() {
  await waitFor(async()=> (await events()).some(e=>e.event==='stopped'), 'normal Quit')
  const rows=await events()
  await waitFor(()=>{try{process.kill(rows[0].pid,0);return false}catch{return true}},'app process exit')
  appPids.delete(rows[0].pid)
  return rows
}
try {
  assert.equal(running(baseTarget),false,'test identity is not in use')
  // Never alter a prior test's ownership record or job.
  try {await readFile(receipt);throw new Error('Test receipt already exists; inspect prior test first')} catch(e) {if(e.code!=='ENOENT')throw e}
  const ready=await launch(original)
  assert.equal(ready.owned,true)
  const rows=await finished()
  const closed=rows.find(e=>e.event==='closed'), reopened=rows.find(e=>e.event==='reopened')
  assert.equal(closed.visible,false);assert.equal(closed.accessory,true)
  assert.equal(reopened.visible,true);assert.equal(reopened.accessory,false)
  assert(ready.menu.includes('打开管理界面'))
  assert.equal(running(ready.target),false)
  console.log('PASS: menu entry, close-to-background, reopen, normal Quit.')

  const crashed=await launch(original,'--smoke-hold')
  const before=JSON.parse(await readFile(receipt,'utf8'))
  process.kill(crashed.pid,'SIGKILL')
  await waitFor(()=>{try{process.kill(crashed.pid,0);return false}catch{return true}},'crash exit')
  appPids.delete(crashed.pid)
  assert.equal(running(crashed.target),true)
  const moved=join(dir,'Moved Resident App.app')
  await cp(original,moved,{recursive:true,verbatimSymlinks:true})
  const adopted=await launch(moved)
  assert.equal(adopted.owned,true)
  assert.equal(adopted.target,crashed.target)
  assert.equal(JSON.parse(await readFile(receipt,'utf8')).token,before.token)
  await finished()
  assert.equal(running(crashed.target),false)
  console.log('PASS: SIGKILL leaves service alive; relocated App adopts it and Quit stops it.')

  const interrupted=await launch(moved,'--smoke-quit-start')
  await finished()
  assert.equal(running(interrupted.target),false)
  console.log('PASS: Quit during startup cleans up the newly started job.')

  const node=join(moved,'Contents/Helpers/node'), entry=join(moved,'Contents/Resources/gateway/lib/types/app/cli.js')
  direct=spawn(node,[entry,'start',config],{stdio:'ignore'})
  await waitFor(async()=>{try{return (await fetch(`http://127.0.0.1:${port}/`)).ok}catch{return false}},'external server')
  const external=await launch(moved)
  assert.equal(external.owned,false)
  await finished()
  assert.equal(direct.exitCode,null)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200)
  console.log('PASS: directly launched external Gateway survives App Quit.')
  assert.equal(JSON.parse(await readFile(config,'utf8')).port,port)
} finally {
  for(const pid of appPids) {try{process.kill(pid,'SIGKILL')}catch{}}
  if(direct && direct.exitCode===null) await new Promise(resolve=>{direct.once('exit',resolve);direct.kill('SIGTERM')})
  try {const owner=JSON.parse(await readFile(receipt,'utf8'));if(owner.config===config){cleanup.add(`gui/${process.getuid()}/${owner.label}`)}}catch{}
  for(const target of cleanup) {try{execFileSync('/bin/launchctl',['bootout',target],{stdio:'ignore'})}catch{}}
  try {const owner=JSON.parse(await readFile(receipt,'utf8'));if(cleanup.has(`gui/${process.getuid()}/${owner.label}`)){await rm(owner.plist,{force:true});await rm(receipt,{force:true})}}catch{}
  await rm(dir,{recursive:true,force:true})
}

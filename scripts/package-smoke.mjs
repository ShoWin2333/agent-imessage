// Install the actual production tarball in isolation; no developer/DSH modules may be required.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseTrailingJsonArray } from './pack-report.mjs'
const exec = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'agent-package-'))
let child
try {
  const packed = await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], { maxBuffer: 2_000_000 })
  const [{ filename }] = parseTrailingJsonArray(packed.stdout)
  await exec('tar', ['-xzf', join(dir, filename), '-C', dir])
  const cwd = join(dir, 'package')
  await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd, maxBuffer: 2_000_000 })
  await exec(process.execPath, ['--input-type=module', '-e', 'await import("@cursor/sdk"); await import("./lib/types/index.js")'], { cwd })
  const config = join(dir, 'config.json')
  await writeFile(config, JSON.stringify({ port:0, stateDir:join(dir,'state'), routes:[] }), { mode:0o600 })
  child = spawn(process.execPath, ['lib/types/app/cli.js', 'start', config], { cwd, stdio:['ignore','pipe','pipe'] })
  child.stderr.resume()
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged app did not start')), 15_000)
    const lines = createInterface({ input:child.stdout })
    lines.on('line', line => { const match=line.match(/Agent iMessage: (http:\/\/127\.0\.0\.1:\d+)/); if(match){clearTimeout(timer);resolve(match[1])} })
    child.once('exit', () => {clearTimeout(timer);reject(new Error('Packaged app exited'))})
  })
  assert.equal((await fetch(url)).status,404)
  const state=await (await fetch(url+'/api/state')).json()
  assert.deepEqual(state.config.routes,[])
  assert.equal(typeof state.csrf,'string')
  const dependencies=JSON.parse(await readFile(join(cwd,'package.json'),'utf8')).dependencies
  assert.equal(Object.keys(dependencies).some(name=>name.startsWith('@deepseek-ai/')),false)
  console.log('PASS: production tarball installed without dev/DSH dependencies; SDK imports and native-app API boots.')
} finally {
  if(child && child.exitCode === null) await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})
  await rm(dir,{recursive:true,force:true})
}

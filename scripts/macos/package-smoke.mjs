// Run against an already built bundle, after relocating it outside the checkout.
import assert from 'node:assert/strict'
import {spawn, execFileSync} from 'node:child_process'
import {cp, mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createInterface} from 'node:readline'

if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('Usage: npm run test:macos:package -- /path/to/App.app')
const dir = await mkdtemp(join(tmpdir(), 'gateway-relocated-'))
let child
try {
  const app = join(dir, 'Moved App.app')
  await cp(resolve(process.argv[2]), app, {recursive:true, verbatimSymlinks:true})
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  await assert.rejects(access(join(app, 'Contents/Resources/gateway.plist')), {code:'ENOENT'})
  const home = join(dir, 'fresh-home')
  await mkdir(home, {mode:0o700})
  const node = join(app, 'Contents/Helpers/node')
  const entry = join(app, 'Contents/Resources/gateway/lib/types/app/cli.js')
  const environment = {HOME:home, PATH:'/usr/bin:/bin', TMPDIR:dir}
  const config = join(home, 'config.json')
  const boot = async () => {
    child = spawn(node, [entry, 'start', config], {cwd:home, env:environment, stdio:['ignore','pipe','pipe']})
    child.stderr.resume()
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bundled server did not start')), 15000)
      const lines = createInterface({input:child.stdout})
      child.once('error', error => {clearTimeout(timer); reject(error)})
      child.once('exit', () => {clearTimeout(timer); reject(new Error('Bundled server exited early'))})
      lines.on('line', line => {
        const match = line.match(/Agent iMessage: (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {clearTimeout(timer); resolve(match[1])}
      })
    })
  }
  const stop = async () => {
    if (child && child.exitCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', () => {clearTimeout(timer); resolve()})
      child.kill('SIGTERM')
    })
  }
  await writeFile(config, JSON.stringify({port:0, stateDir:join(home,'state'), routes:[]}), {mode:0o600})
  let url = await boot()
  assert.equal((await fetch(url)).status, 404)
  for (const name of ['app.js', 'style.css', 'brand.png']) assert.equal((await fetch(`${url}/${name}`)).status, 404)
  let state = await (await fetch(`${url}/api/state`)).json()
  assert.deepEqual(state.config.routes, [])
  const snapshot = await readFile(config, 'utf8')
  await stop()
  url = await boot()
  state = await (await fetch(`${url}/api/state`)).json()
  assert.deepEqual(state.config.routes, [])
  assert.equal(await readFile(config, 'utf8'), snapshot)
  await stop()
  // Also cover first-run creation with no config or pre-existing HOME data.
  const script = `import {loadAppConfig,atomicJson,defaultConfigFile} from ${JSON.stringify(pathToFileURL(join(app,'Contents/Resources/gateway/lib/types/app/config.js')).href)}; await atomicJson(defaultConfigFile,await loadAppConfig(defaultConfigFile));`
  execFileSync(node, ['--input-type=module', '-e', script], {cwd:home, env:environment})
  const created = JSON.parse(await readFile(join(home, '.config/agent-imessage/config.json'),'utf8'))
  assert.deepEqual(created.routes, [])
  assert.equal(created.stateDir, join(home,'.local/state/agent-imessage'))
  console.log('PASS: relocated signed bundle, minimal PATH, isolated HOME, native-only API, first-run config and restart persistence.')
} finally {
  if (child && child.exitCode === null) {
    await new Promise(resolve => {child.once('exit',resolve); child.kill('SIGKILL')})
  }
  await rm(dir, {recursive:true, force:true})
}

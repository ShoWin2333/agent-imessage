import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseTrailingJsonArray } from './pack-report.mjs'
const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'agent-imessage-pack-'))
try {
  const prefix = join(temporary, 'install'); await mkdir(prefix)
  const { stdout } = await execute('npm', ['pack', './packages/codex', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root })
  const report = parseTrailingJsonArray(stdout)[0]
  assert.ok(report.files.some(file => file.path === 'dist/agent-imessage.js'))
  assert.ok(report.files.some(file => file.path === 'LICENSE'))
  await execute('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, report.filename)])
  const installed = join(prefix, 'node_modules/@showin2333/agent-imessage')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.ok(!Object.keys(manifest.dependencies).some(name => name.includes('deepseek')))
  const help = await execute(process.execPath, [join(installed, 'dist/agent-imessage.js'), '--help'], { cwd: temporary })
  assert.match(help.stdout, /agent-imessage doctor/)
  const fixture = join(temporary, 'fake-cursor')
  await writeFile(fixture, `#!/usr/bin/env node
const {createInterface} = require('node:readline');
if(process.argv[2] !== 'acp') process.exit(2);
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if(request.jsonrpc !== '2.0') process.exit(3);
  const result = request.method === 'initialize' ? {protocolVersion:1,agentCapabilities:{loadSession:true}} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});
`, { mode: 0o700 })
  const doctor = await execute(process.execPath, [join(installed, 'dist/agent-imessage.js'), 'doctor', 'cursor', fixture], { cwd: temporary })
  assert.match(doctor.stdout, /Cursor ACP connected and authenticated/)
  console.log('PASS: standalone tarball installs and starts outside the source checkout, without DSH.')
  console.log('PASS: installed Cursor doctor exchanges ACP messages with a simulated CLI (not real account acceptance).')
} finally { await rm(temporary, { recursive: true, force: true }) }

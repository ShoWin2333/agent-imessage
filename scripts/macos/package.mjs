// Self-contained, host-architecture bundle. Development builds remain lightweight.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync, readdirSync, openSync, readSync, closeSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS is required')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appName = process.env.AGENT_GATEWAY_APP_NAME ?? 'Agent iMessage'
const output = resolve(process.argv[2] ?? join(root, 'dist', `${appName}.app`))
if (existsSync(output)) throw new Error('Choose a new output path; existing apps are not overwritten')
const version = '22.23.2'
const hashes = {
  arm64: '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
  x64: '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
}
if (!hashes[process.arch]) throw new Error('Unsupported architecture')
const work = mkdtempSync(join(tmpdir(), 'agent-macos-package-'))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {cwd:root, stdio:'inherit', ...opts})
try {
  run('npm', ['run', 'build'])
  const archiveName = `node-v${version}-darwin-${process.arch}`
  const archive = join(work, 'node.tar.gz')
  run('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--output', archive, `https://nodejs.org/dist/v${version}/${archiveName}.tar.gz`])
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== hashes[process.arch]) throw new Error('Node archive checksum mismatch')
  run('/usr/bin/tar', ['-xzf', archive, '-C', work])
  const node = join(work, archiveName, 'bin/node')
  const linkage = execFileSync('/usr/bin/otool', ['-L', node], {encoding:'utf8'})
  for (const line of linkage.split('\n').slice(1).filter(Boolean)) {
    if (!/^\s*\/(usr\/lib|System\/Library)\//.test(line)) throw new Error(`Non-system Node dependency: ${line}`)
  }
  const app = join(work, `${appName}.app`)
  run(process.execPath, ['scripts/macos/build.mjs', app], {env:{...process.env, AGENT_GATEWAY_STANDALONE:'1'}})
  const payload = join(app, 'Contents/Resources/gateway')
  mkdirSync(payload, {recursive:true})
  for (const name of ['package.json', 'package-lock.json', 'lib', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(join(root, name), join(payload, name), {recursive:true})
  }
  // Install only the locked production graph; never copy the developer node_modules.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], {cwd:payload})
  const helpers = join(app, 'Contents/Helpers')
  mkdirSync(helpers)
  cpSync(node, join(helpers, 'node'))
  cpSync(join(work, archiveName, 'LICENSE'), join(app, 'Contents/Resources/Node-LICENSE'))
  // Native dependency executables must be signed before signing the outer bundle.
  function signMachO(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path)
      if (stat.isDirectory()) signMachO(path)
      else if (stat.isFile()) {
        const header = Buffer.alloc(4), fd = openSync(path, 'r')
        try { readSync(fd, header, 0, 4, 0) } finally { closeSync(fd) }
        if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca', 'cafebabf'].includes(header.toString('hex'))) {
          // Preserve upstream signatures and entitlements (notably Cursor sandbox).
          try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', path], {stdio:'ignore'}) }
          catch { run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', path]) }
        }
      }
    }
  }
  signMachO(join(payload, 'node_modules'))
  run('/usr/bin/codesign', ['--force', '--sign', '-', join(helpers, 'node')])
  writeFileSync(join(app, 'Contents/Resources/build-info.json'), JSON.stringify({node:version, arch:process.arch, app:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version}, null, 2) + '\n')
  run('/usr/bin/codesign', ['--force', '--sign', '-', app])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  mkdirSync(dirname(output), {recursive:true})
  // Copy rather than rename: output may be on a different volume.
  cpSync(app, output, {recursive:true, verbatimSymlinks:true})
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', output])
  console.log(`Standalone ${process.arch} app: ${output}`)
} finally {
  rmSync(work, {recursive:true, force:true})
}

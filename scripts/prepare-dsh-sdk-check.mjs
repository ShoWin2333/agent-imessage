// Prepare an isolated SDK test copy. This script never installs dependencies
// or changes the source checkout, application profiles, or running DSH.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = process.argv[3] ?? '0.2.2-rc.1'
if (!['0.2.1-rc.5', '0.2.2-rc.1'].includes(sdk)) throw new Error('Unsupported SDK test version')
const modern = sdk === '0.2.2-rc.1'
const cordis = modern ? '4.1.0' : '4.0.5'
const loader = modern ? '1.1.0' : '1.0.6'
const destination = resolve(process.argv[2] ?? '')
const within = relative(root, destination)
if (!process.argv[2] || !within.startsWith(`..${sep}`) || existsSync(destination)) {
  throw new Error('Provide a new destination outside the source checkout')
}
const excluded = new Set(['.git', 'node_modules', 'lib'])
cpSync(root, destination, { recursive: true, filter: path => !excluded.has(relative(root, path).split(sep)[0]) })
const manifest = JSON.parse(readFileSync(resolve(destination, 'package.json'), 'utf8'))
for (const section of ['devDependencies', 'overrides']) {
  for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (version === '0.2.1-rc.2') manifest[section][name] = sdk
    if (name === '@deepseek-ai/cordis') manifest[section][name] = cordis
    if (name === '@deepseek-ai/cordis-plugin-loader') manifest[section][name] = loader
  }
}
if (modern) manifest.devDependencies['@deepseek-ai/dsh-tool-executor-native'] = sdk
writeFileSync(resolve(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const workspacePath = resolve(destination, 'pnpm-workspace.yaml')
writeFileSync(workspacePath, readFileSync(workspacePath, 'utf8')
  .replaceAll('0.2.1-rc.2', sdk).replaceAll('4.0.5', cordis).replaceAll('1.0.6', loader)
  .replace('overrides:\n', `overrides:\n  "@deepseek-ai/cordis-plugin-include": "${loader}"\n`))
console.log(destination)

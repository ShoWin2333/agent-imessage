#!/usr/bin/env node
import { resolve } from 'node:path'
import { defaultConfigFile, loadAppConfig, loadSecrets, importConfig, atomicJson } from './config.js'
import { Gateway } from '../gateway/app.js'
import { startServer } from './server.js'
import { service } from './service.js'

async function main(): Promise<void> {
  const [command = 'start', arg, extra, credential] = process.argv.slice(2)
  if (command === '--help' || command === 'help') {
    console.log('Agent iMessage Gateway\n  start [config.json]       Start local Web UI and enabled routes\n  import SOURCE DEST [DSH_CREDENTIAL_EXPORT]  Migrate without modifying source\n  service install|remove [config.json]       macOS background service\nNo Cursor Desktop, Codex Desktop or DSH Web required.')
    return
  }
  if (command === 'import') { if (!arg || !extra) throw new Error('Source and destination required'); await importConfig(resolve(arg), resolve(extra), credential && resolve(credential)); console.log('Configuration migrated. Source unchanged.'); return }
  if (command === 'service') { await service(arg, resolve(extra ?? defaultConfigFile)); return }
  if (command !== 'start') throw new Error('Unknown command; use --help')
  const file = resolve(arg ?? defaultConfigFile)
  const config = await loadAppConfig(file), secrets = await loadSecrets(`${file}.secrets.json`)
  // Creates the first-run config before any listener or backend starts.
  // Existing bridge files are accepted in memory; save from UI explicitly migrates them.
  const { stat } = await import('node:fs/promises')
  try { await stat(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicJson(file, config) }
  const gateway = new Gateway(config, secrets)
  const server = await startServer(file, config, secrets, gateway)
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await server.close()
    await gateway.stop()
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  console.log(`Agent iMessage: ${server.url}`)
  await gateway.start()
}
void main().catch(() => { console.error('Agent iMessage could not start. Check config, private directory permissions and port availability. No credentials were printed.'); process.exitCode = 1 })

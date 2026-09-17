import { mkdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
export async function service(action: string | undefined, configFile: string): Promise<void> {
  if (process.platform !== 'darwin' || !process.getuid) throw new Error('Service installation currently supports macOS launchd')
  const label = 'app.agent-imessage.gateway'
  const file = join(homedir(), 'Library/LaunchAgents', `${label}.plist`)
  const domain = `gui/${process.getuid()}`
  if (action === 'remove') { await run('launchctl', ['bootout', `${domain}/${label}`]); await rm(file); console.log('Background service removed. Configuration retained.'); return }
  if (action !== 'install') throw new Error('Use service install or remove')
  const logs = join(dirname(configFile), 'logs')
  await mkdir(logs, { recursive: true, mode: 0o700 })
  await mkdir(dirname(file), { recursive: true })
  const args = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url)), 'start', configFile]
  await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${escape(arg)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${escape(join(logs, 'gateway.log'))}</string><key>StandardErrorPath</key><string>${escape(join(logs, 'gateway.log'))}</string></dict></plist>\n`, { mode: 0o600, flag: 'wx' })
  await run('launchctl', ['bootstrap', domain, file])
  console.log('Agent iMessage background service installed. It starts at login and restarts after failure.')
}

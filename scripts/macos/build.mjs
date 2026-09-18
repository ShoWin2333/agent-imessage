import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync, existsSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {resolve, join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS is required')
const appName = process.env.AGENT_GATEWAY_APP_NAME ?? 'Agent iMessage'
const bundleId = process.env.AGENT_GATEWAY_BUNDLE_ID ?? 'app.agent-imessage.desktop'
if (!/^[A-Za-z0-9 _-]+$/.test(appName) || !/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('Invalid app identity')
const source = dirname(fileURLToPath(import.meta.url))
const destination = resolve(process.argv[2] ?? '/tmp/Agent iMessage.app')
const standalone = process.env.AGENT_GATEWAY_STANDALONE === '1'
const service = resolve(process.argv[3] ?? join(homedir(), 'Library/LaunchAgents/app.agent-imessage.gateway.plist'))
if (existsSync(destination)) throw new Error('Choose a new output path; existing apps are not overwritten')
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
let plist, serviceXml
if (standalone) {
  plist = {Label:bundleId === 'app.agent-imessage.desktop' ? 'app.agent-imessage.gateway' : `${bundleId}.gateway`, ProgramArguments:[]}
} else if (existsSync(service)) {
  plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', service], {encoding:'utf8'}))
  serviceXml = readFileSync(service,'utf8')
} else {
  if (process.argv[3]) throw new Error('Specified service plist does not exist')
  const configFile = resolve(process.env.AGENT_GATEWAY_CONFIG ?? join(homedir(),'.config/agent-imessage/config.json'))
  const logs = join(dirname(configFile),'logs')
  mkdirSync(logs,{recursive:true,mode:0o700})
  const args = [process.execPath,resolve(source,'../../lib/types/app/cli.js'),'start',configFile]
  plist = {Label:'app.agent-imessage.gateway',ProgramArguments:args}
  serviceXml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${plist.Label}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${escape(a)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${escape(join(logs,'gateway.log'))}</string><key>StandardErrorPath</key><string>${escape(join(logs,'gateway.log'))}</string></dict></plist>`
}
const configPath = plist.ProgramArguments[3]
const config = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath,'utf8')) : {}
const port = config.port ?? 8787
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Desktop wrapper requires a fixed port from 1 to 65535')
mkdirSync(join(destination, 'Contents/MacOS'), {recursive:true})
mkdirSync(join(destination, 'Contents/Resources'), {recursive:true})
execFileSync('/usr/bin/xcrun', ['swiftc', join(source, 'Main.swift'), join(source, 'GatewayService.swift'), '-o', join(destination, `Contents/MacOS/${appName}`), '-framework', 'Cocoa', '-framework', 'WebKit', '-module-cache-path', '/private/tmp/agent-imessage-swift-cache'], {stdio:'inherit'})
const iconName = 'AppIcon-' + createHash('sha256').update(readFileSync(resolve(source, '../../public/brand.png'))).digest('hex').slice(0,12)
const iconset = join(destination, 'Contents/Resources/AppIcon.iconset')
execFileSync('/usr/bin/xcrun', ['swift', '-module-cache-path', '/private/tmp/agent-imessage-swift-cache', join(source, 'Icon.swift'), iconset, resolve(source, '../../public/brand.png')], {stdio:'inherit'})
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(destination, `Contents/Resources/${iconName}.icns`)], {stdio:'inherit'})
// Do not register this plist in LaunchAgents: the app loads/unloads it itself.
if (!standalone) writeFileSync(join(destination, 'Contents/Resources/gateway.plist'),serviceXml,{mode:0o600})
writeFileSync(join(destination, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>${appName}</string>
<key>CFBundleExecutable</key><string>${appName}</string>
<key>CFBundleIconFile</key><string>${iconName}.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
${standalone ? "<key>GatewayStandalone</key><true/>" : ""}
<key>GatewayURL</key><string>http://127.0.0.1:${port}/</string>
<key>GatewayServiceLabel</key><string>${escape(plist.Label)}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`)
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', destination], {stdio:'inherit'})
console.log(destination)

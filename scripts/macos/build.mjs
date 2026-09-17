import {execFileSync} from 'node:child_process'
import {mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {resolve, join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS is required')
const source = dirname(fileURLToPath(import.meta.url))
const destination = resolve(process.argv[2] ?? '/tmp/Agent iMessage.app')
const service = resolve(process.argv[3] ?? join(homedir(), 'Library/LaunchAgents/app.agent-imessage.gateway.plist'))
if (existsSync(destination)) throw new Error('Choose a new output path; existing apps are not overwritten')
const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', service], {encoding:'utf8'}))
const config = JSON.parse(readFileSync(plist.ProgramArguments[3], 'utf8'))
if (config.port && config.port !== 8787) throw new Error('This local wrapper currently requires UI port 8787')
mkdirSync(join(destination, 'Contents/MacOS'), {recursive:true})
mkdirSync(join(destination, 'Contents/Resources'), {recursive:true})
execFileSync('/usr/bin/xcrun', ['swiftc', join(source, 'Main.swift'), '-o', join(destination, 'Contents/MacOS/Agent iMessage'), '-framework', 'Cocoa', '-framework', 'WebKit', '-module-cache-path', '/private/tmp/agent-imessage-swift-cache'], {stdio:'inherit'})
const iconset = join(destination, 'Contents/Resources/AppIcon.iconset')
execFileSync('/usr/bin/xcrun', ['swift', '-module-cache-path', '/private/tmp/agent-imessage-swift-cache', join(source, 'Icon.swift'), iconset], {stdio:'inherit'})
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(destination, 'Contents/Resources/AppIcon.icns')], {stdio:'inherit'})
// Do not register this plist in LaunchAgents: the app loads/unloads it itself.
copyFileSync(service, join(destination, 'Contents/Resources/gateway.plist'))
writeFileSync(join(destination, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.agent-imessage.desktop</string>
<key>CFBundleName</key><string>Agent iMessage</string>
<key>CFBundleExecutable</key><string>Agent iMessage</string>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
`)
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', destination], {stdio:'inherit'})
console.log(destination)

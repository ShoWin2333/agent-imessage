import {execFileSync} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
if (process.platform !== 'darwin') throw new Error('macOS is required')
const source = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'gateway-service-tests-'))
try {
  const binary = join(work,'tests')
  execFileSync('/usr/bin/xcrun', ['swiftc',join(source,'GatewayService.swift'),join(source,'ServiceLifecycleTests.swift'),'-o',binary,'-module-cache-path',join(work,'cache')], {stdio:'inherit'})
  execFileSync(binary, [], {stdio:'inherit', timeout:60000})
} finally { rmSync(work,{recursive:true,force:true}) }

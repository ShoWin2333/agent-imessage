import {execFileSync} from 'node:child_process'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const source=dirname(fileURLToPath(import.meta.url)), work=mkdtempSync(join(tmpdir(),'native-store-tests-'))
try {
  const binary=join(work,'tests')
  execFileSync('/usr/bin/xcrun',['swiftc',join(source,'Native/Models/GatewayModels.swift'),join(source,'Native/Stores/GatewayStore.swift'),join(source,'NativeStoreTests.swift'),'-o',binary,'-framework','SwiftUI','-module-cache-path',join(work,'cache')],{stdio:'inherit'})
  execFileSync(binary,[],{stdio:'inherit',timeout:30000})
} finally {rmSync(work,{recursive:true,force:true})}

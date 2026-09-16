#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { CursorServer } from '../cursor/rpc.js'
import { AppServer } from './rpc.js'
import { CodexRouter } from './router.js'
import { StateStore } from './state.js'
import { SpectrumSupervisor, createSpectrumConnection } from '../spectrum-runtime.js'

async function main(): Promise<void> {
  const [command, file, binary] = process.argv.slice(2)
  if (command === '--help' || !command) {
    console.log('agent-imessage doctor [codex|cursor] [binary] | agent-imessage start /absolute/path/config.json\nAuthenticate locally with codex login or agent login for the selected backend. doctor defaults to Codex. See the package README for Photon setup.')
    return
  }
  if (command === 'doctor') {
    if (file && file !== 'codex' && file !== 'cursor') throw new Error('Unknown backend')
    const rpc = file === 'cursor'
      ? CursorServer.spawn(binary ?? 'agent', { id: 'doctor', backend: 'cursor', cwd: process.cwd(), projectId: 'unused', projectSecretEnv: 'UNUSED', senderPhoneNumber: '+15551234567', assignedPhoneNumber: '+15557654321' }, [])
      : new AppServer(binary ?? 'codex')
    try {
      await rpc.initialize()
      if (file === 'cursor') { console.log('Cursor ACP connected and authenticated.'); return }
      const result = await rpc.request('account/read', { refreshToken: false })
      console.log(result.account || result.requiresOpenaiAuth === false ? 'Codex App Server connected; account available.' : 'Codex App Server connected; run codex login before starting the bridge.')
      if (!result.account && result.requiresOpenaiAuth !== false) process.exitCode = 1
    } finally { rpc.close() }
    return
  }
  if (command !== 'start' || !file) throw new Error('Usage: agent-imessage start /absolute/path/config.json')
  const config = await loadConfig(resolve(file))
  const cleanups: Array<() => Promise<void>> = []
  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  try {
    for (const route of config.routes) {
      const store = await StateStore.open(config.stateDir, route)
      const secrets = config.routes.map(item => item.projectSecretEnv)
      const rpc = route.backend === 'cursor' ? CursorServer.spawn(config.cursorBinary, route, secrets) : new AppServer(config.codexBinary, route.cwd, secrets)
      const router = new CodexRouter(rpc, route, store)
      const supervisor = new SpectrumSupervisor(createSpectrumConnection, {
        reconnectMinMs: 1000, reconnectMaxMs: 60_000,
        onState: state => { router.setConnected(state.phase === 'listening'); console.log(`[${route.id}] ${state.phase}`) },
        onMessage: message => router.receive(message),
      })
      const routerClose = rpc.onClose
      rpc.onClose = () => {
        routerClose()
        if (!closing) { console.error('Agent connection closed; stopping bridge.'); process.exitCode = 1; void shutdown() }
      }
      cleanups.push(async () => { router.close(); await supervisor.stop(); await store.close() })
      await rpc.initialize()
      if (route.backend !== 'cursor') {
        const account = await rpc.request('account/read', { refreshToken: false })
        if (!account.account && account.requiresOpenaiAuth !== false) throw new Error('Run codex login before starting the bridge')
      }
      if (closing) break
      await supervisor.restart({ projectId: route.projectId, projectSecret: process.env[route.projectSecretEnv]!, senderPhoneNumber: route.senderPhoneNumber, assignedPhoneNumber: route.assignedPhoneNumber })
      if (!supervisor.healthy) throw new Error('Photon connection unavailable; verify project configuration')
    }
  } catch (error) { await shutdown(); throw error }
}

void main().catch(() => { console.error('Agent iMessage could not start. Check the config, Photon environment variables, state directory lock/permissions, and the selected agent login. No credentials were printed.'); process.exitCode = 1 })

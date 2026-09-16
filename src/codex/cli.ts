#!/usr/bin/env node
import { resolve } from 'node:path'
import { loadConfig } from './config.js'
import { AppServer } from './rpc.js'
import { CodexRouter } from './router.js'
import { StateStore } from './state.js'
import { SpectrumSupervisor, createSpectrumConnection } from '../spectrum-runtime.js'

async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2)
  if (command === '--help' || !command) {
    console.log('agent-imessage doctor | agent-imessage start /absolute/path/config.json\nAuthenticate locally with codex login first. See the package README for Photon setup.')
    return
  }
  if (command === 'doctor') {
    const rpc = new AppServer()
    try {
      await rpc.initialize()
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
      const rpc = new AppServer(config.codexBinary, route.cwd, config.routes.map(item => item.projectSecretEnv))
      const router = new CodexRouter(rpc, route, store)
      const supervisor = new SpectrumSupervisor(createSpectrumConnection, {
        reconnectMinMs: 1000, reconnectMaxMs: 60_000,
        onState: state => { router.setConnected(state.phase === 'listening'); console.log(`[${route.id}] ${state.phase}`) },
        onMessage: message => router.receive(message),
      })
      const routerClose = rpc.onClose
      rpc.onClose = () => {
        routerClose()
        if (!closing) { console.error('Codex connection closed; stopping bridge.'); process.exitCode = 1; void shutdown() }
      }
      cleanups.push(async () => { router.close(); await supervisor.stop(); await store.close() })
      await rpc.initialize()
      const account = await rpc.request('account/read', { refreshToken: false })
      if (!account.account && account.requiresOpenaiAuth !== false) throw new Error('Run codex login before starting the bridge')
      if (closing) break
      await supervisor.restart({ projectId: route.projectId, projectSecret: process.env[route.projectSecretEnv]!, senderPhoneNumber: route.senderPhoneNumber, assignedPhoneNumber: route.assignedPhoneNumber })
      if (!supervisor.healthy) throw new Error('Photon connection unavailable; verify project configuration')
    }
  } catch (error) { await shutdown(); throw error }
}

void main().catch(() => { console.error('Agent iMessage could not start. Check the config, Photon environment variables, state directory lock/permissions, and codex login. No credentials were printed.'); process.exitCode = 1 })

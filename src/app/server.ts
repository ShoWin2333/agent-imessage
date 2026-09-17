import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { object } from '../backends/jsonrpc.js'
import { atomicJson, validateConfig, type AppConfig, type Secrets } from './config.js'
import { PluginError } from '../errors.js'
import { listModels } from '../backends/catalog.js'
import { PhotonAccount } from './photon.js'
import type { Gateway } from '../gateway/app.js'

const publicDir = existsSync(new URL('../../public/index.html', import.meta.url)) ? new URL('../../public/', import.meta.url) : new URL('../../../public/', import.meta.url)

async function body(req: IncomingMessage): Promise<unknown> {
  let value = ''
  for await (const chunk of req) { value += String(chunk); if (Buffer.byteLength(value) > 128_000) throw new Error('Request too large') }
  return JSON.parse(value)
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value)) }
export async function startServer(configFile: string, initial: AppConfig, initialSecrets: Secrets, gateway: Gateway) {
  const photonAccount = new PhotonAccount(`${configFile}.photon.json`)
  await photonAccount.load()
  let config = initial, secrets = initialSecrets
  const selectedSecrets = new Map<string, {projectId: string; secret: string}>()
  let revision = 0
  let mutation = Promise.resolve()
  const token = randomBytes(32).toString('hex')
  let origin = ''
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Local requests only' }); return }
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; form-action 'self'")
      if (req.method === 'GET' && (req.url === '/' || req.url === '/app.js' || req.url === '/style.css')) {
        const name = req.url === '/' ? 'index.html' : req.url.slice(1)
        const content = await readFile(new URL(name, publicDir))
        res.writeHead(200, { 'content-type': name.endsWith('html') ? 'text/html; charset=utf-8' : name.endsWith('js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-store' }).end(content); return
      }
      if (req.method === 'GET' && req.url === '/api/state') {
        json(res, 200, { config, revision, authorization: photonAccount.snapshot(), csrf: token, routes: gateway.snapshot(), hasCursorKey: Boolean(secrets.cursorApiKey || process.env.CURSOR_API_KEY), hasPhotonSecret: Object.fromEntries(config.routes.map(r => [r.id, Boolean(secrets.photon[r.id] || process.env[r.projectSecretEnv])])) }); return
      }
      const provided = Buffer.from(String(req.headers['x-agent-token'] ?? ''))
      if (req.method !== 'POST' || req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json') || provided.length !== token.length || !timingSafeEqual(provided, Buffer.from(token))) { json(res, 403, { error: 'Invalid local request' }); return }
      const input = object(await body(req))
      const work = mutation.then(async () => {
        if (req.url === '/api/photon/projects') {
          try { json(res, 200, {projects: await photonAccount.projects()}) }
          catch { json(res, 400, {error:'无法读取 Photon 项目，请先完成或更新 Photon 项目管理授权。'}) }
          return
        }
        if (req.url === '/api/models') {
          if (typeof input.backend !== 'string' || !['cursor','codex','dsh'].includes(input.backend)) throw new Error('Invalid backend')
          try { json(res, 200, {models: await listModels(input.backend, typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(), config, secrets, typeof input.id === 'string' ? input.id : undefined, typeof input.model === 'string' ? input.model : undefined)}) }
          catch { json(res, 400, {error:'无法读取模型列表，请检查对应 backend 的登录、密钥和工作目录；也可手动输入模型 ID。'}) }
          return
        }
        if (req.url === '/api/save' || req.url === '/api/save-route') {
          if (input.revision !== revision) { json(res, 409, { error: 'Configuration changed. Reload before saving.' }); return }
          const single = req.url === '/api/save-route'
          let routeInput = object(input.route)
          if (single && (typeof input.id !== 'string' || routeInput.id !== input.id)) throw new Error('Route ID cannot change in a single-project save')
          if (single) routeInput = (await validateConfig({...config, routes:[routeInput]})).routes[0]!
          const next = await validateConfig(single ? {...config, routes: config.routes.some(r => r.id === input.id)
            ? config.routes.map(r => r.id === input.id ? routeInput : r)
            : [...config.routes, routeInput]} : input.config, !single)
          if (next.port !== config.port || next.stateDir !== config.stateDir || next.codexBinary !== config.codexBinary || next.dshBinary !== config.dshBinary) throw new Error('Change startup fields in the config file and restart')
          const nextSecrets: Secrets = { ...secrets, photon: { ...secrets.photon } }
          if (!single && typeof input.cursorApiKey === 'string' && input.cursorApiKey.trim()) nextSecrets.cursorApiKey = input.cursorApiKey.trim()
          const photon = object(input.photon)
          for (const route of next.routes) {
            if (single && route.id !== input.id) continue
            if (typeof photon[route.id] === 'string' && photon[route.id]) nextSecrets.photon[route.id] = String(photon[route.id]).trim()
            else if (selectedSecrets.get(route.id)?.projectId === route.projectId) nextSecrets.photon[route.id] = selectedSecrets.get(route.id)!.secret
            else if (config.routes.some(r => r.id === route.id && r.projectId !== route.projectId)) delete nextSecrets.photon[route.id]
          }
          for (const id of Object.keys(nextSecrets.photon)) if (!next.routes.some(r => r.id === id)) delete nextSecrets.photon[id]
          await atomicJson(`${configFile}.secrets.json`, nextSecrets)
          await atomicJson(configFile, next)
          secrets = nextSecrets; config = next; revision++
          if (single) {
            selectedSecrets.delete(String(input.id))
            await gateway.replaceRoute(String(input.id), config, secrets)
          } else { selectedSecrets.clear(); await gateway.replace(config, secrets) }
        } else if (req.url === '/api/photon/authorize') await photonAccount.begin()
        else if (req.url === '/api/photon/cancel') photonAccount.cancel()
        else if ((req.url === '/api/photon/provision' || req.url === '/api/photon/select')) {
          if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || typeof input.name !== 'string' || typeof input.sender !== 'string' || !/^\+[1-9]\d{6,14}$/.test(input.sender)) throw new Error('Invalid provisioning request')
          const provision = req.url === '/api/photon/select'
            ? await photonAccount.select(String(input.projectId ?? ''), input.sender)
            : await photonAccount.provision(input.name, input.sender)
          selectedSecrets.set(input.id, {projectId:provision.projectId, secret:provision.secret})
          json(res, 200, { projectId: provision.projectId, assignedPhoneNumber: provision.assignedPhoneNumber }); return
        } else if (req.url === '/api/start') { await gateway.stop(); await gateway.start() }
        else if (req.url === '/api/stop') await gateway.stop()
        else { json(res, 404, { error: 'Not found' }); return }
        json(res, 200, { ok: true })
      })
      mutation = work.catch(() => {})
      await work
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: error instanceof PluginError ? error.public().message : '操作失败：请检查号码格式、Photon 管理授权及网络连接。' }); else res.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local address')
  origin = `http://127.0.0.1:${address.port}`
  return { url: origin, close: async () => { photonAccount.cancel(); await mutation; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

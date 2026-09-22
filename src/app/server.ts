import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { object } from '../backends/jsonrpc.js'
import { atomicJson, validateConfig, type AppConfig, type Secrets } from './config.js'
import { PluginError } from '../errors.js'
import { listModels } from '../backends/catalog.js'
import { photonAccounts, publicPhotonAccounts } from './channel-accounts.js'
import { telegramAccounts, updateTelegram } from './telegram.js'
import { WeixinLogin } from './weixin.js'
import { WeixinError } from '../channels/weixin-api.js'
import { routeChannels, photonSecretKey } from '../gateway/config.js'
import { nextRuns, scheduleSchema } from '../gateway/cron.js'
import { PhotonAccount } from './photon.js'
import type { Gateway } from '../gateway/app.js'

async function body(req: IncomingMessage): Promise<unknown> {
  let value = ''
  for await (const chunk of req) { value += String(chunk); if (Buffer.byteLength(value) > 512_000) throw new Error('Request too large') }
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
  let loginMutation = Promise.resolve()
  const weixinLogin = new WeixinLogin(credential => {
    const work = mutation.then(async () => {
      const next = {...secrets,weixin:{...secrets.weixin,[credential.accountId]:credential}}
      await gateway.replace(config,next,() => atomicJson(`${configFile}.secrets.json`,next))
      secrets = next
    })
    mutation = work.catch(() => {})
    return work
  })
  const token = randomBytes(32).toString('hex')
  let origin = ''
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { json(res, 403, { error: 'Local requests only' }); return }
      res.setHeader('x-content-type-options', 'nosniff')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'")
      if (req.method === 'GET' && req.url === '/api/state') {
        const state = { config, revision, telegramAccounts:telegramAccounts(config,secrets), photonAccounts:publicPhotonAccounts(config,secrets), weixinLogin:weixinLogin.snapshot(), weixinAccounts:Object.values(secrets.weixin ?? {}).map(c=>({accountId:c.accountId})), authorization: photonAccount.snapshot(), csrf: token, routes: gateway.snapshot(), hasCursorKey: Boolean(secrets.cursorApiKey || process.env.CURSOR_API_KEY), hasPhotonSecret: Object.fromEntries(config.routes.map(r => [r.id, routeChannels(r).some(c=>c.kind === 'imessage' && Boolean(secrets.photon[photonSecretKey(r,c)] || process.env[c.projectSecretEnv]))])) }
        const payload = JSON.stringify(state)
        const etag = '"' + createHash('sha256').update(payload).digest('hex') + '"'
        res.setHeader('etag',etag)
        if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return }
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(payload); return
      }
      if (req.method === 'GET') { json(res,404,{error:'Use the native macOS app'}); return }
      const provided = Buffer.from(String(req.headers['x-agent-token'] ?? ''))
      if (req.method !== 'POST' || req.headers.origin !== origin || !String(req.headers['content-type']).startsWith('application/json') || provided.length !== token.length || !timingSafeEqual(provided, Buffer.from(token))) { json(res, 403, { error: 'Invalid local request' }); return }
      const input = object(await body(req))
      if (['/api/weixin/begin','/api/weixin/cancel','/api/weixin/verify'].includes(req.url ?? '')) {
        const work = loginMutation.then(async () => {
          if (req.url === '/api/weixin/begin') await weixinLogin.begin()
          else if (req.url === '/api/weixin/cancel') await weixinLogin.cancel()
          else weixinLogin.verify(String(input.id ?? ''),String(input.code ?? ''))
          json(res,200,{ok:true})
        })
        loginMutation = work.catch(() => {})
        await work
        return
      }
      if (req.url === '/api/conversations/send') {
        if (typeof input.text !== 'string') throw new PluginError('invalid-command','请输入消息。')
        await gateway.converse(String(input.routeId),String(input.channelId),input.text,typeof input.sessionId === 'string' ? input.sessionId : undefined,input.fresh === true,typeof input.messageId === 'string' ? input.messageId : undefined)
        json(res,200,{ok:true}); return
      }
      if (req.url === '/api/tasks/history') {
        json(res,200,await gateway.taskHistory(String(input.routeId),String(input.channelId),typeof input.cursor === 'string' ? input.cursor : undefined,typeof input.sessionId === 'string' ? input.sessionId : undefined)); return
      }
      if (req.url === '/api/tasks/detail') {
        json(res,200,{task:await gateway.taskDetail(String(input.routeId),String(input.channelId),String(input.taskId),typeof input.archiveKey === 'string' ? input.archiveKey : undefined)}); return
      }
      if (req.url === '/api/tasks/control') {
        await gateway.control(String(input.routeId),String(input.channelId),String(input.taskId),String(input.action),typeof input.requestId === 'string' ? input.requestId : undefined,input.answers as Record<string,string> | undefined,typeof input.archiveKey === 'string' ? input.archiveKey : undefined)
        json(res,200,{ok:true}); return
      }
      const work = mutation.then(async () => {
        if (req.url === '/api/telegram/save') {
          if (input.revision !== revision) { json(res,409,{error:'Configuration changed. Reload before saving.'}); return }
          if ('routeId' in input) throw new PluginError('invalid-command','请在 Agent 的消息入口中管理绑定。')
          const next = await updateTelegram(config,secrets,input)
          await gateway.replace(next.config,next.secrets,async()=>{
            await atomicJson(`${configFile}.secrets.json`,next.secrets)
            await atomicJson(configFile,next.config)
          })
          config=next.config; secrets=next.secrets; revision++
          json(res,200,{ok:true,botId:next.botId}); return
        }
        if (req.url === '/api/schedules/preview') {
          const task = scheduleSchema.parse(input.schedule)
          json(res,200,{runs:nextRuns(task.cron,task.timeZone)}); return
        }
        if (req.url === '/api/schedules/run') {
          await gateway.runSchedule(String(input.routeId),String(input.scheduleId))
          json(res,200,{ok:true}); return
        }
        if (req.url === '/api/photon/account') {
          if (input.revision !== revision) { json(res,409,{error:'Configuration changed'}); return }
          if (typeof input.sender !== 'string' || !/^\+[1-9]\d{6,14}$/.test(input.sender) || typeof input.name !== 'string' || !input.name.trim()) throw new PluginError('invalid-command','请填写项目名称和含国家区号的手机号。')
          if (input.projectId && config.routes.some(r=>routeChannels(r).some(c=>c.kind==='imessage' && c.projectId===input.projectId))) throw new PluginError('invalid-command','该 Photon 项目已绑定 Agent，请先在 Agent 页解绑。')
          const resource = input.projectId ? await photonAccount.select(String(input.projectId),input.sender) : await photonAccount.provision(input.name,input.sender)
          const nextSecrets: Secrets = {...secrets,photonAccounts:{...photonAccounts(config,secrets),[resource.projectId]:{secret:resource.secret,assignedPhoneNumber:resource.assignedPhoneNumber,senderPhoneNumber:input.sender}}}
          await atomicJson(`${configFile}.secrets.json`,nextSecrets)
          secrets=nextSecrets; revision++
          json(res,200,{ok:true}); return
        }
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
          const nextSecrets: Secrets = { ...secrets, telegramAccounts:Object.fromEntries(telegramAccounts(config,secrets).filter(a=>a.ownerUserId).map(a=>[a.botId,{ownerUserId:a.ownerUserId,username:a.username}])), telegram: { ...secrets.telegram }, photonAccounts:photonAccounts(config,secrets), photon: { ...secrets.photon } }
          if (!single && typeof input.cursorApiKey === 'string' && input.cursorApiKey.trim()) nextSecrets.cursorApiKey = input.cursorApiKey.trim()
          const photon = object(input.photon)
          for (const route of next.routes) {
            if (single && route.id !== input.id) continue
            for (const channel of routeChannels(route)) {
              if (channel.kind === 'telegram') {
                const token = object(input.telegram)[`${route.id}:${channel.id}`]
                if (typeof token === 'string' && token.trim()) {
                  if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/.test(token.trim()) || token.trim().split(':')[0] !== channel.botId) throw new Error('Telegram token must match the bot ID')
                  nextSecrets.telegram![channel.botId] = token.trim()
                }
                if (!nextSecrets.telegram?.[channel.botId]) throw new Error('Provide a Telegram Bot Token')
                const account = nextSecrets.telegramAccounts?.[channel.botId]
                if (account && account.ownerUserId !== channel.ownerUserId) throw new PluginError('invalid-command','请在消息渠道中修改 Telegram 允许操作的用户。')
                continue
              }
              if (channel.kind === 'weixin') {
                if (!Object.hasOwn(secrets.weixin ?? {},channel.accountId)) throw new Error('Bind Weixin first')
                continue
              }
              const key = photonSecretKey(route,channel), prior = config.routes.find(r=>r.id === route.id)
              const priorChannel = prior && routeChannels(prior).find(c=>c.kind === 'imessage' && c.id === channel.id && c.projectId === channel.projectId)
              const inputSecret = photon[key] ?? (channel.id === 'imessage' ? photon[route.id] : undefined)
              if (typeof inputSecret === 'string' && inputSecret.trim()) nextSecrets.photon[key] = inputSecret.trim()
              else if (nextSecrets.photonAccounts?.[channel.projectId]) nextSecrets.photon[key] = nextSecrets.photonAccounts[channel.projectId]!.secret
              else if (selectedSecrets.get(route.id)?.projectId === channel.projectId) nextSecrets.photon[key] = selectedSecrets.get(route.id)!.secret
              else if (prior && priorChannel) {
                const old = secrets.photon[photonSecretKey(prior,priorChannel)]
                if (old) nextSecrets.photon[key] = old
              } else delete nextSecrets.photon[key]
            }
          }
          const validKeys = new Set(next.routes.flatMap(r=>routeChannels(r).filter(c=>c.kind === 'imessage').map(c=>photonSecretKey(r,c))))
          for (const id of Object.keys(nextSecrets.photon)) if (!validKeys.has(id)) delete nextSecrets.photon[id]
          await gateway.replace(next,nextSecrets,async () => {
            await atomicJson(`${configFile}.secrets.json`, nextSecrets)
            await atomicJson(configFile, next)
          })
          secrets = nextSecrets; config = next; revision++
          if (single) selectedSecrets.delete(String(input.id)); else selectedSecrets.clear()
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
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: error instanceof PluginError ? error.public().message : error instanceof WeixinError ? error.message : '操作失败：请检查项目配置、渠道绑定及网络连接。' }); else res.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local address')
  origin = `http://127.0.0.1:${address.port}`
  return { url: origin, close: async () => { photonAccount.cancel(); await loginMutation; await weixinLogin.cancel(); await mutation; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

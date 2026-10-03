import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, ChannelType, Events, GatewayIntentBits, MessageType, REST, Routes, type ClientOptions, type ClientUser } from 'discord.js'
import { DiscordAdapter, splitDiscordText, type DiscordScope } from '../src/channels/discord.js'
import type { ChannelMessage } from '../src/channels/types.js'
import { appSchema, validateConfig, loadSecrets } from '../src/app/config.js'
import { discordAccounts, updateDiscord } from '../src/app/discord.js'
import { Gateway } from '../src/gateway/app.js'
import { BaseBackend, type SessionOptions } from '../src/backends/types.js'
import * as weixinApi from '../src/channels/weixin-api.js'
import { startServer } from '../src/app/server.js'
import { StateStore } from '../src/gateway/state.js'

const scope: DiscordScope = {id:'discord',kind:'discord',botId:'123456789012345678',ownerUserId:'234567890123456789'}
const guildScope: DiscordScope = {...scope,guildId:'345678901234567890',channelId:'456789012345678901'}
const token = 'synthetic-discord-bot-token'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); vi.useRealTimers()})

class FakeClient extends EventEmitter {
  user = {id:scope.botId,bot:true} as ClientUser
  ready = false
  login = vi.fn(async (_token: string) => {this.ready = true; return token})
  destroy = vi.fn(async () => {this.ready = false})
  isReady = () => this.ready
  rest = {post:vi.fn(async (_route: string, _data: Record<string,unknown>) => ({}))}
  users = {createDM:vi.fn(async (_id: string) => ({id:'567890123456789012',type:ChannelType.DM,recipientId:_id}))}
  channels = {fetch:vi.fn(async (_id: string) => ({id:guildScope.channelId!,guildId:guildScope.guildId!,type:ChannelType.GuildText,permissionsFor:() => ({has:() => true})}))}
}
function raw(overrides: Record<string,unknown> = {}) {
  return {id:'678901234567890123',channelId:'567890123456789012',guildId:null,
    author:{id:scope.ownerUserId,bot:false},content:'hello',webhookId:null,system:false,type:MessageType.Default,
    channel:{type:ChannelType.DM},...overrides}
}
async function adapter(binding = scope, client = new FakeClient(), onMessage = vi.fn(async (_message: ChannelMessage) => {})) {
  let options: ClientOptions | undefined
  const value = new DiscordAdapter(binding,token,onMessage,() => {},input => {options = input; return client as unknown as Client})
  cleanup.push(() => value.stop())
  await value.start(); await expect.poll(() => value.state.phase).toBe('listening')
  return {value,client,onMessage,options}
}
// node:timers/promises uses native timers; substitute an abortable clock for fake-time tests.
function mockPause() {
  vi.spyOn(weixinApi,'pause').mockImplementation((signal,ms = 1000) => new Promise<void>((resolve,reject) => {
    if (signal.aborted) {reject(signal.reason); return}
    const onAbort = () => {clearTimeout(timer); reject(signal.reason)}
    const timer = setTimeout(() => {signal.removeEventListener('abort',onAbort); resolve()},ms)
    signal.addEventListener('abort',onAbort,{once:true})
  }))
}
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'discord-test-')))
  cleanup.push(() => rm(dir,{recursive:true,force:true}))
  return dir
}

it('splits long Discord output losslessly without breaking emoji and bounds pathological graphemes', () => {
  const text = 'a'.repeat(1999)+'😀'+'é'.repeat(2100)+'👨‍👩‍👧‍👦'
  const parts = splitDiscordText(text)
  expect(parts.join('')).toBe(text); expect(parts.every(p => p.length <= 2000)).toBe(true)
  expect(parts[0]).toBe('a'.repeat(1999)); expect(parts[1]?.startsWith('😀')).toBe(true)
  expect(splitDiscordText('')).toEqual([])
  expect(() => splitDiscordText('a'+'\u0301'.repeat(2100))).toThrow('oversized')
})
it('accepts only the owner DM and rejects bots, webhooks, systems, group DMs and other channels', async () => {
  const {client,onMessage,options} = await adapter()
  expect(options?.intents).toEqual([GatewayIntentBits.DirectMessages])
  for (const invalid of [
    {author:{id:'other',bot:false}}, {author:{id:scope.ownerUserId,bot:true}}, {author:{id:scope.botId,bot:true}},
    {webhookId:'webhook'}, {system:true}, {type:MessageType.ChannelPinnedMessage}, {guildId:guildScope.guildId},
    {channel:{type:ChannelType.GroupDM}}, {channelId:'other'}, {content:'   '},
  ]) client.emit(Events.MessageCreate,raw(invalid))
  await Promise.resolve(); expect(onMessage).not.toHaveBeenCalled()
  client.emit(Events.MessageCreate,raw())
  await expect.poll(() => onMessage.mock.calls.length).toBe(1)
  expect(onMessage.mock.calls[0]![0]).toMatchObject({id:'discord:567890123456789012:678901234567890123',text:'hello',nativeVoice:false})
})
it('requires an explicit bot mention, exact server and exact channel in server mode', async () => {
  const {client,onMessage,options} = await adapter(guildScope)
  expect(options?.intents).toEqual([GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages])
  const guild = {guildId:guildScope.guildId,channelId:guildScope.channelId,channel:{type:ChannelType.GuildText}}
  for (const invalid of [{content:'hello'},{content:`<@&${scope.botId}> role`},{guildId:'other',content:`<@${scope.botId}> hello`},{channelId:'other',content:`<@${scope.botId}> hello`}]) client.emit(Events.MessageCreate,raw({...guild,...invalid}))
  await Promise.resolve(); expect(onMessage).not.toHaveBeenCalled()
  client.emit(Events.MessageCreate,raw({...guild,content:`<@!${scope.botId}> /status <@${scope.botId}>`}))
  await expect.poll(() => onMessage.mock.calls.length).toBe(1)
  expect(onMessage.mock.calls[0]![0].text).toBe('/status')
})
it('chunks output, disables all mentions, sends files, and fences stale delivery after stop', async () => {
  const {value,client} = await adapter()
  const message = await value.scheduledMessage('schedule','task')
  await message.send('x'.repeat(2100)+' @everyone <@123>')
  expect(client.rest.post).toHaveBeenCalledTimes(2)
  for (const [route,data] of client.rest.post.mock.calls) {
    expect(route).toBe(Routes.channelMessages('567890123456789012'))
    expect(data.body).toMatchObject({allowed_mentions:{parse:[],replied_user:false}})
    expect(data.signal).toBeInstanceOf(AbortSignal)
  }
  await message.sendFile({bytes:Buffer.from('test'),name:'result.txt',mimeType:'text/plain'})
  expect(client.rest.post.mock.calls.at(-1)?.[1]).toMatchObject({files:[{name:'result.txt',contentType:'text/plain'}]})
  await expect(message.sendFile({bytes:Buffer.alloc(10*1024*1024+1),name:'large',mimeType:'application/octet-stream'})).rejects.toThrow('10 MiB')
  await expect(message.sendVoice({bytes:Buffer.from('a'),name:'a.wav',mimeType:'audio/wav'})).rejects.toThrow('file delivery')
  const signal = client.rest.post.mock.calls[0]![1].signal as AbortSignal
  await value.stop(); expect(signal.aborted).toBe(true)
  await expect(message.send('stale')).rejects.toThrow()
  expect(client.rest.post).toHaveBeenCalledTimes(3)
})
it('maintains typing during work and stops its timer on completion', async () => {
  const {value,client} = await adapter()
  const message = await value.scheduledMessage('typing','task')
  mockPause(); vi.useFakeTimers()
  let done!: () => void
  const work = message.responding(() => new Promise<void>(resolve => {done = resolve}))
  await vi.advanceTimersByTimeAsync(8100)
  expect(client.rest.post.mock.calls.filter(([route]) => route.endsWith('/typing'))).toHaveLength(2)
  done(); await work
  await vi.advanceTimersByTimeAsync(16000)
  expect(client.rest.post).toHaveBeenCalledTimes(2)
})
it('does not hold completed work open behind a rate-limited typing request and tolerates teardown errors', async () => {
  const {value,client} = await adapter()
  const message = await value.scheduledMessage('typing','task')
  client.rest.post.mockImplementation(() => new Promise(() => {}))
  await expect(message.responding(async () => 'done')).resolves.toBe('done')
  expect((client.rest.post.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true)
  client.destroy.mockRejectedValueOnce(new Error('private token'))
  await expect(value.stop()).resolves.toBeUndefined()
})
it('redacts send failures and isolates an admission error from subsequent messages', async () => {
  const handler = vi.fn(async (_message: ChannelMessage) => {}).mockRejectedValueOnce(new Error('private admission failure'))
  const {value,client} = await adapter(scope,new FakeClient(),handler)
  client.emit(Events.MessageCreate,raw())
  client.emit(Events.MessageCreate,raw({id:'next'}))
  await expect.poll(() => handler.mock.calls.length).toBe(2)
  client.rest.post.mockRejectedValueOnce(new Error('token secret /private/path'))
  const message = await value.scheduledMessage('send','task')
  await expect(message.send('hello')).rejects.toThrow('Discord message delivery failed')
  expect(value.state.phase).toBe('listening')
})
it('handles SDK reconnect/resume and fatal invalidation with redacted health', async () => {
  const {value,client} = await adapter()
  client.emit(Events.ShardReconnecting,0); expect(value.state.phase).toBe('retrying')
  await expect(value.scheduledMessage('s','t')).rejects.toThrow('not connected')
  client.emit(Events.ShardResume,0,1); expect(value.state.phase).toBe('listening')
  client.emit(Events.Error,new Error('private-token /private/path'))
  client.emit(Events.ShardDisconnect,{code:4014},0); expect(value.state.phase).toBe('failed')
  client.emit(Events.ShardResume,0,1); expect(value.state.phase).toBe('failed')
  expect(JSON.stringify(value.state)).not.toMatch(/private-token|private\/path/)
  expect(client.destroy).toHaveBeenCalled()
})
it('rejects a wrong bot or inaccessible server before enabling routing', async () => {
  for (const kind of ['bot','guild','permissions']) {
    const client = new FakeClient()
    if (kind === 'bot') client.user = {id:'wrong',bot:true} as ClientUser
    if (kind === 'guild') client.channels.fetch.mockResolvedValue({...await client.channels.fetch(''),guildId:'wrong'})
    if (kind === 'permissions') client.channels.fetch.mockResolvedValue({...await client.channels.fetch(''),permissionsFor:() => ({has:() => false})})
    const handler = vi.fn(async (_message: ChannelMessage) => {})
    const value = new DiscordAdapter(guildScope,token,handler,() => {},() => client as unknown as Client)
    cleanup.push(() => value.stop()); await value.start()
    await expect.poll(() => value.state.phase).toBe('failed')
    client.emit(Events.MessageCreate,raw()); expect(handler).not.toHaveBeenCalled()
  }
})
it('retries temporary startup failures and stops promptly during a hung login', async () => {
  const failed = new FakeClient(), healthy = new FakeClient()
  failed.login.mockRejectedValueOnce(new Error('network private-token'))
  let calls = 0
  const value = new DiscordAdapter(scope,token,async () => {},() => {},() => (calls++ === 0 ? failed : healthy) as unknown as Client)
  cleanup.push(() => value.stop()); mockPause(); vi.useFakeTimers(); await value.start()
  await vi.advanceTimersByTimeAsync(1100); expect(value.state.phase).toBe('listening'); expect(calls).toBe(2)
  await value.stop()
  const client = new FakeClient(); client.login.mockImplementation(() => new Promise(() => {}))
  const hung = new DiscordAdapter(scope,token,async () => {},() => {},() => client as unknown as Client)
  cleanup.push(() => hung.stop()); await hung.start(); await hung.stop()
  expect(hung.state.phase).toBe('stopped'); expect(client.destroy).toHaveBeenCalled()
})
it('serializes admission, bounds the queue and starts a new generation independently of old handlers', async () => {
  const client = new FakeClient(); let release!: () => void
  const handler = vi.fn(async () => {await new Promise<void>(resolve => {release = resolve})})
  const {value} = await adapter(scope,client,handler)
  for (let n=0;n<100;n++) client.emit(Events.MessageCreate,raw({id:String(n)}))
  await expect.poll(() => handler.mock.calls.length).toBe(1)
  await value.stop()
  const oldRelease = release
  await value.start(); await expect.poll(() => value.state.phase).toBe('listening')
  client.emit(Events.MessageCreate,raw({id:'new'}))
  await expect.poll(() => handler.mock.calls.length).toBe(2)
  oldRelease(); release(); await value.stop()
  await Promise.resolve(); expect(handler).toHaveBeenCalledTimes(2)
})
it('validates IDs, unique bot ownership and paired server/channel fields', async () => {
  const route = {id:'one',cwd:'/workspace',channels:[scope]}
  expect(appSchema.safeParse({routes:[route]}).success).toBe(true)
  for (const ownerUserId of ['@name','0','-1','18446744073709551616',scope.botId]) expect(appSchema.safeParse({routes:[{...route,channels:[{...scope,ownerUserId}]}]}).success).toBe(false)
  for (const pair of [{guildId:guildScope.guildId},{channelId:guildScope.channelId}]) expect(appSchema.safeParse({routes:[{...route,channels:[{...scope,...pair}]}]}).success).toBe(false)
  await expect(validateConfig({routes:[route,{...route,id:'two'}]},false)).rejects.toThrow('unique')
})
it('verifies bot identity before storing credentials and preserves blank tokens without exposing secrets', async () => {
  const config = appSchema.parse({routes:[]}), secrets = {photon:{}}
  const verify = vi.fn(async (_token: string) => ({id:scope.botId,bot:true,username:'agent'}))
  await expect(updateDiscord(config,secrets,{token,ownerUserId:'@invalid'},verify)).rejects.toThrow('numeric')
  await expect(updateDiscord(config,secrets,{token,ownerUserId:Number(scope.ownerUserId)},verify)).rejects.toThrow('numeric')
  expect(verify).not.toHaveBeenCalled()
  const next = await updateDiscord(config,secrets,{token,ownerUserId:scope.ownerUserId},verify)
  expect(next.secrets.discord).toEqual({[scope.botId]:token})
  const retained = await updateDiscord(config,next.secrets,{botId:scope.botId,token:'',ownerUserId:scope.ownerUserId},verify)
  expect(retained.secrets.discord).toEqual(next.secrets.discord)
  expect(JSON.stringify(discordAccounts(config,next.secrets))).not.toContain(token)
  await expect(updateDiscord(config,secrets,{token,ownerUserId:scope.ownerUserId},async () => ({id:scope.botId,bot:false}))).rejects.toThrow('bot')
  await expect(updateDiscord(config,secrets,{token,ownerUserId:scope.ownerUserId},async () => {throw new Error('secret leak')})).rejects.toThrow('Could not verify')
})

class Backend extends BaseBackend {
  initialize = async () => {}
  openSession = vi.fn(async (options: SessionOptions) => ({id:options.id ?? 'session',cwd:options.cwd}))
  startTurn = vi.fn(async (sessionId: string, _text: string) => {this.onEvent({type:'started',sessionId,turnId:'turn'}); return 'turn'})
  cancel = async () => {}
  close = async () => {this.onClose()}
}
it('routes two distinct bots owned by one user to independent Agent sessions and replies', async () => {
  const dir = await fixture(), secondDir = await fixture(), botB = '789012345678901234'
  const bindings = [scope,{...scope,botId:botB}]
  const clients: FakeClient[] = [], backends: Backend[] = []
  const config = appSchema.parse({stateDir:dir,routes:bindings.map((binding,i) => ({id:`agent-${i}`,cwd:i === 0 ? dir : secondDir,backend:'codex',channels:[binding]}))})
  const gateway = new Gateway(config,{photon:{},discord:{[scope.botId]:token,[botB]:'synthetic-second-token'}},
    () => {const backend = new Backend(); backends.push(backend); return backend},undefined,
    () => {const client = new FakeClient(); client.user = {id:bindings[clients.length]!.botId,bot:true} as ClientUser; clients.push(client); return client as unknown as Client})
  cleanup.push(() => gateway.stop()); await gateway.start()
  await expect.poll(() => gateway.snapshot().map(r => r.phase)).toEqual(['listening','listening'])
  clients[0]!.emit(Events.MessageCreate,raw({content:'Alice task'}))
  clients[1]!.emit(Events.MessageCreate,raw({content:'Jane task'}))
  await expect.poll(() => backends.map(b => b.startTurn.mock.calls.length)).toEqual([1,1])
  expect(backends[0]!.startTurn.mock.calls[0]![1]).toBe('Alice task')
  expect(backends[1]!.startTurn.mock.calls[0]![1]).toBe('Jane task')
  for (let i=0;i<2;i++) {
    backends[i]!.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'answer',text:`reply-${i}`})
    backends[i]!.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
    await expect.poll(() => clients[i]!.rest.post.mock.calls.filter(([,data]) => (data.body as {content?:string} | undefined)?.content).length).toBe(1)
    expect(clients[i]!.rest.post.mock.calls.find(([,data]) => (data.body as {content?:string} | undefined)?.content)?.[1].body).toMatchObject({content:`reply-${i}`})
  }
})
it('routes through the real gateway, replies, deduplicates across restart and resets on owner/scope changes', async () => {
  const dir = await fixture(), clients: FakeClient[] = [], backends: Backend[] = []
  const config = appSchema.parse({stateDir:dir,routes:[{id:'agent',cwd:dir,backend:'codex',model:'gpt-6.1-sol',effort:'high',channels:[scope]}]})
  const secrets = {photon:{},discord:{[scope.botId]:token}}
  const gateway = new Gateway(config,secrets,() => {const backend = new Backend(); backends.push(backend); return backend},undefined,() => {const client = new FakeClient(); clients.push(client); return client as unknown as Client})
  cleanup.push(() => gateway.stop()); await gateway.start()
  await expect.poll(() => gateway.snapshot()[0]?.phase).toBe('listening')
  clients[0]!.emit(Events.MessageCreate,raw())
  await expect.poll(() => backends[0]!.startTurn.mock.calls.length).toBe(1)
  expect(backends[0]!.openSession.mock.calls[0]![0]).toMatchObject({model:'gpt-6.1-sol',effort:'high'})
  backends[0]!.onEvent({type:'message',sessionId:'session',turnId:'turn',id:'answer',text:'Discord answer'})
  backends[0]!.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(() => clients[0]!.rest.post.mock.calls.some(([,data]) => (data.body as {content?:string} | undefined)?.content === 'Discord answer')).toBe(true)
  await expect.poll(() => gateway.snapshot()[0]?.busy).toBe(false)
  await gateway.stop(); await gateway.start()
  await expect.poll(() => gateway.snapshot()[0]?.phase).toBe('listening')
  clients[1]!.emit(Events.MessageCreate,raw())
  await expect.poll(() => gateway.snapshot()[0]?.channels[0]?.activity?.at(-1)?.stage).toBe('duplicate')
  expect(backends[1]!.startTurn).not.toHaveBeenCalled()
  const next = appSchema.parse({...config,routes:[{...config.routes[0],channels:[{...scope,ownerUserId:'789012345678901234'}]}]})
  await gateway.replace(next,secrets)
  await expect.poll(() => gateway.snapshot()[0]?.phase).toBe('listening')
  clients[2]!.emit(Events.MessageCreate,raw({author:{id:'789012345678901234',bot:false}}))
  await expect.poll(() => backends[2]!.startTurn.mock.calls.length).toBe(1)
  expect(backends[2]!.openSession.mock.calls[0]![0].id).toBeUndefined()
  backends[2]!.onEvent({type:'completed',sessionId:'session',turnId:'turn',status:'completed'})
  await expect.poll(() => gateway.snapshot()[0]?.busy).toBe(false)
  // Use guild mode next to verify destination changes also reset the session.
  await gateway.replace(appSchema.parse({...config,routes:[{...config.routes[0],channels:[guildScope]}]}),secrets)
  await expect.poll(() => gateway.snapshot()[0]?.phase).toBe('listening')
  clients[3]!.emit(Events.MessageCreate,raw({guildId:guildScope.guildId,channelId:guildScope.channelId,content:`<@${scope.botId}> fresh`,channel:{type:ChannelType.GuildText}}))
  await expect.poll(() => backends[3]!.startTurn.mock.calls.length).toBe(1)
  expect(backends[3]!.openSession.mock.calls[0]![0].id).toBeUndefined()
  const approval = backends[3]!.onRequest({kind:'approval',sessionId:'session',turnId:'turn',payload:{method:'bridge/requestApproval',details:{command:'echo hello'}}})
  await expect.poll(() => gateway.snapshot()[0]?.channels[0]?.requests?.length).toBe(1)
  const requestId = gateway.snapshot()[0]!.channels[0]!.requests![0]!.id
  const reply = {guildId:guildScope.guildId,channelId:guildScope.channelId,channel:{type:ChannelType.GuildText},content:`<@${scope.botId}> /approve ${requestId}`}
  clients[3]!.emit(Events.MessageCreate,raw({...reply,id:'unauthorized',author:{id:'other',bot:false}}))
  clients[3]!.emit(Events.MessageCreate,raw({...reply,id:'unmentioned',content:`/approve ${requestId}`}))
  await Promise.resolve(); expect(gateway.snapshot()[0]?.channels[0]?.requests).toHaveLength(1)
  clients[3]!.emit(Events.MessageCreate,raw({...reply,id:'approved'}))
  await expect(approval).resolves.toEqual({decision:'accept'})
})

it('preserves the legacy iMessage session when adding a Discord binding to the same Agent', async () => {
  const dir = await fixture()
  const route = {id:'legacy',cwd:dir,projectId:'photon',projectSecretEnv:'SECRET',senderPhoneNumber:'+15551234567',assignedPhoneNumber:'+15557654321'}
  const original = appSchema.parse({stateDir:dir,routes:[route]})
  const stored = await StateStore.open(dir,original.routes[0]!)
  stored.state.threadId = 'imessage-session'; stored.state.sessions = ['imessage-session']; await stored.save(); await stored.close()
  const backends: Backend[] = [], clients: FakeClient[] = []
  let deliver!: (message?: ChannelMessage) => void
  const secrets = {photon:{legacy:'synthetic-photon'},discord:{[scope.botId]:token}}
  const gateway = new Gateway(original,secrets,() => {const b = new Backend(); backends.push(b); return b},async () => {
    let end!: () => void, first!: (message?: ChannelMessage) => void
    const message = new Promise<ChannelMessage | undefined>(resolve => {first = resolve; deliver = resolve})
    const ended = new Promise<void>(resolve => {end = resolve})
    return {messages:{async *[Symbol.asyncIterator]() {
      const inbound = await message
      if (inbound) yield inbound
      await ended
    }},stop:async () => {first(); end()}}
  },() => {const c = new FakeClient(); clients.push(c); return c as unknown as Client})
  cleanup.push(() => gateway.stop()); await gateway.start()
  const send = vi.fn(async () => {})
  const {id:_id,cwd:_cwd,...binding} = route
  const updated = appSchema.parse({...original,routes:[{...route,channels:[{...binding,id:'imessage',kind:'imessage'},scope]}]})
  // Channel objects contain only binding fields, not route/workspace configuration.
  // The native save API carries the legacy Photon secret into its new binding key.
  await gateway.replace(updated,{...secrets,photon:{...secrets.photon,'legacy:imessage':'synthetic-photon'}})
  await expect.poll(() => gateway.snapshot()[0]?.channels.map(c => c.phase)).toEqual(['listening','listening'])
  deliver({id:'imessage:hello',text:'hello',send,sendFile:async () => {},sendVoice:async () => {},responding:fn => fn()})
  await expect.poll(() => backends[1]?.startTurn.mock.calls.length).toBe(1)
  expect(backends[1]!.openSession.mock.calls[0]![0].id).toBe('imessage-session')
  backends[1]!.onEvent({type:'message',sessionId:'imessage-session',turnId:'turn',id:'result',text:'iMessage still works'})
  backends[1]!.onEvent({type:'completed',sessionId:'imessage-session',turnId:'turn',status:'completed'})
  await expect.poll(() => send.mock.calls.length).toBeGreaterThan(0)
  expect(clients).toHaveLength(1)
})
it('saves two bots for the same owner, binds separate Agents and keeps both credentials private', async () => {
  const dir = await fixture(), file = join(dir,'config.json'), config = appSchema.parse({stateDir:dir,port:0})
  const gateway = new Gateway(config,{photon:{}})
  const server = await startServer(file,config,{photon:{}},gateway)
  cleanup.push(() => gateway.stop()); cleanup.push(() => server.close())
  const secondBotId = '789012345678901234', secondToken = 'synthetic-second-discord-token'
  vi.spyOn(REST.prototype,'get')
    .mockResolvedValueOnce({id:scope.botId,bot:true,username:'Alice'})
    .mockResolvedValueOnce({id:secondBotId,bot:true,username:'Jane'})
  const state = await (await fetch(server.url+'/api/state')).json()
  const post = (path: string, data: object) => fetch(server.url+path,{method:'POST',headers:{origin:server.url,'content-type':'application/json','x-agent-token':state.csrf},body:JSON.stringify(data)})
  expect((await post('/api/discord/save',{revision:0,token,ownerUserId:scope.ownerUserId})).status).toBe(200)
  expect((await post('/api/discord/save',{revision:1,token:secondToken,ownerUserId:scope.ownerUserId})).status).toBe(200)
  const route = {id:'agent',cwd:dir,enabled:false,channels:[scope]}
  expect((await post('/api/save-route',{revision:2,id:'agent',route})).status).toBe(200)
  const secondRoute = {...route,id:'second-agent',channels:[{...scope,botId:secondBotId}]}
  expect((await post('/api/save-route',{revision:3,id:secondRoute.id,route:secondRoute})).status).toBe(200)
  expect((await loadSecrets(file+'.secrets.json')).discord).toEqual({[scope.botId]:token,[secondBotId]:secondToken})
  const publicState = await (await fetch(server.url+'/api/state')).json()
  expect(publicState.discordAccounts).toEqual([
    {botId:scope.botId,username:'Alice',ownerUserId:scope.ownerUserId,routeId:'agent',channelId:scope.id},
    {botId:secondBotId,username:'Jane',ownerUserId:scope.ownerUserId,routeId:'second-agent',channelId:scope.id},
  ])
  expect(publicState.config.routes.map((r: {id:string,channels:DiscordScope[]}) => [r.id,r.channels[0]!.botId])).toEqual([['agent',scope.botId],['second-agent',secondBotId]])
  expect((await stat(file+'.secrets.json')).mode & 0o777).toBe(0o600)
  expect(await readFile(file,'utf8')).not.toContain(token)
  expect(await readFile(file,'utf8')).not.toContain(secondToken)
  expect(JSON.stringify(publicState)).not.toContain(token)
  expect(JSON.stringify(publicState)).not.toContain(secondToken)
  expect((await post('/api/discord/save',{revision:0,botId:scope.botId,token:'',ownerUserId:scope.ownerUserId})).status).toBe(409)
})

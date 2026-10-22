import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, ChannelType, Events, GatewayIntentBits, MessageType, REST, Routes, type ClientOptions, type ClientUser } from 'discord.js'
import { DiscordAdapter, splitDiscordText, type DiscordScope } from '../src/channels/discord.js'
import type { ChannelMessage } from '../src/channels/types.js'
import * as weixinApi from '../src/channels/weixin-api.js'

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

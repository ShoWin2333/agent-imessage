import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
  loadOutboundMedia,
  OutboundMediaTools,
  type OutboundMediaPayload,
} from '../src/outbound-media.js'
import type { SpectrumInboundMessage } from '../src/spectrum-runtime.js'
import { attachmentForOutbound, voiceForOutbound } from '../src/spectrum-runtime.js'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-imessage-media-'))
  created.push(dir)
  return dir
}

function agentFor(cwd: string): Agent {
  return {
    id: 'session-a',
    session: { header: { cwd } },
  } as unknown as Agent
}

function toolContext(agent: Agent | undefined, signal = new AbortController().signal): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'tool',
    arguments: {},
    token: Symbol('tool-token') as ToolRunContext['token'],
    signal,
    ...(agent === undefined ? {} : { agent }),
    deferContext: () => {},
  } as ToolRunContext
}

describe('loadOutboundMedia path and type validation', () => {
  it('resolves relative paths against the session cwd and returns basename metadata', async () => {
    const cwd = await tempWorkspace()
    await writeFile(path.join(cwd, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const media = await loadOutboundMedia({
      rawPath: 'photo.png',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: new AbortController().signal,
    })
    expect(media).toMatchObject({ name: 'photo.png', mimeType: 'image/png' })
    expect(media.bytes.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true)
  })

  it('resolves nested workspace files using native path separators', async () => {
    const cwd = await tempWorkspace()
    await mkdir(path.join(cwd, 'reports'))
    await writeFile(path.join(cwd, 'reports', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const media = await loadOutboundMedia({
      rawPath: path.join('reports', 'photo.png'),
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: new AbortController().signal,
    })
    expect(media).toMatchObject({ name: 'photo.png', mimeType: 'image/png' })
  })

  it('rejects symlink escape outside the workspace', async () => {
    const cwd = await tempWorkspace()
    const outside = await tempWorkspace()
    await writeFile(path.join(outside, 'secret.png'), Buffer.from('secret'))
    let rawPath: string
    if (process.platform === 'win32') {
      await symlink(outside, path.join(cwd, 'outside-link'), 'junction')
      rawPath = path.join('outside-link', 'secret.png')
    } else {
      await symlink(path.join(outside, 'secret.png'), path.join(cwd, 'alias.png'))
      rawPath = 'alias.png'
    }
    await expect(loadOutboundMedia({
      rawPath,
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: new AbortController().signal,
    })).rejects.toThrow(/outside the session workspace/u)
  })

  it('rejects path traversal that escapes the workspace', async () => {
    const cwd = await tempWorkspace()
    const sibling = await tempWorkspace()
    await writeFile(path.join(sibling, 'escape.png'), Buffer.from('nope'))
    await expect(loadOutboundMedia({
      rawPath: path.join('..', path.basename(sibling), 'escape.png'),
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: new AbortController().signal,
    })).rejects.toThrow(/outside the session workspace/u)
  })

  it('accepts generic files and rejects missing files, directories, and oversized payloads', async () => {
    const cwd = await tempWorkspace()
    await writeFile(path.join(cwd, 'notes.txt'), 'hello')
    await writeFile(path.join(cwd, 'payload.custom'), 'data')
    await mkdir(path.join(cwd, 'folder'))
    await writeFile(path.join(cwd, 'huge.png'), Buffer.alloc(8))

    await expect(loadOutboundMedia({
      rawPath: 'notes.txt',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: 10,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ name: 'notes.txt', mimeType: 'text/plain' })

    await expect(loadOutboundMedia({
      rawPath: 'payload.custom',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: 10,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ name: 'payload.custom', mimeType: 'application/octet-stream' })

    await expect(loadOutboundMedia({
      rawPath: 'missing.png',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: 4,
      signal: new AbortController().signal,
    })).rejects.toThrow(/was not found/u)

    await expect(loadOutboundMedia({
      rawPath: 'folder',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: 4,
      signal: new AbortController().signal,
    })).rejects.toThrow(/not a regular file|Unsupported/u)

    await expect(loadOutboundMedia({
      rawPath: 'huge.png',
      kind: 'file',
      workspaceCwd: cwd,
      maxBytes: 4,
      signal: new AbortController().signal,
    })).rejects.toThrow(/exceeds the outbound size limit/u)
  })

  it('accepts audio extensions with audio MIME types and cancels when aborted', async () => {
    const cwd = await tempWorkspace()
    await writeFile(path.join(cwd, 'clip.m4a'), Buffer.from('audio'))
    const media = await loadOutboundMedia({
      rawPath: 'clip.m4a',
      kind: 'audio',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: new AbortController().signal,
    })
    expect(media).toMatchObject({ name: 'clip.m4a', mimeType: 'audio/mp4' })

    const abort = new AbortController()
    abort.abort()
    await expect(loadOutboundMedia({
      rawPath: 'clip.m4a',
      kind: 'audio',
      workspaceCwd: cwd,
      maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
      signal: abort.signal,
    })).rejects.toThrow(/cancelled/u)
  })
})

describe('OutboundMediaTools fail-closed ownership', () => {
  it('rejects browser-originated or unhealthy turns and delivers owned file/voice sends', async () => {
    const cwd = await tempWorkspace()
    await writeFile(path.join(cwd, 'photo.jpg'), Buffer.from('img'))
    await writeFile(path.join(cwd, 'note.mp3'), Buffer.from('snd'))
    const selected = agentFor(cwd)
    const files: OutboundMediaPayload[] = []
    const voices: OutboundMediaPayload[] = []
    const channel: SpectrumInboundMessage = {
      id: 'provider-message',
      text: 'prompt',
      responding: async callback => callback(),
      send: async () => {},
      sendFile: async media => { files.push(media) },
      sendVoice: async media => { voices.push(media) },
    }

    let owns = false
    let healthy = false
    const registered: ToolDefinition[] = []
    const agentCtx = {
      tools: {
        register: (definition: ToolDefinition) => {
          registered.push(definition)
          return () => {
            const index = registered.indexOf(definition)
            if (index >= 0) registered.splice(index, 1)
          }
        },
      },
    } as unknown as Context

    const tools = new OutboundMediaTools({
      ownsCurrentTurn: agent => owns && agent === selected,
      channelFor: agent => agent === selected ? channel : undefined,
      deliveryHealthy: () => healthy,
    }, { maxOutboundMediaBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES })

    const dispose = tools.install(agentCtx)
    expect(registered.map(tool => tool.name).sort()).toEqual([
      'send_imessage_file',
      'send_imessage_voice',
    ])

    const file = registered.find(tool => tool.name === 'send_imessage_file')
    const voice = registered.find(tool => tool.name === 'send_imessage_voice')
    expect(file).toBeDefined()
    expect(voice).toBeDefined()

    await expect(file!.execute({ path: 'photo.jpg' }, toolContext(undefined)))
      .rejects.toThrow(/active agent/u)
    await expect(file!.execute({ path: 'photo.jpg' }, toolContext(selected)))
      .rejects.toThrow(/iMessage-owned turn/u)

    owns = true
    await expect(file!.execute({ path: 'photo.jpg' }, toolContext(selected)))
      .rejects.toThrow(/delivery is unavailable/u)

    healthy = true
    await expect(file!.execute({ path: 'photo.jpg' }, toolContext(selected)))
      .resolves.toEqual({ name: 'photo.jpg', mimeType: 'image/jpeg' })
    await expect(voice!.execute({ path: 'note.mp3' }, toolContext(selected)))
      .resolves.toEqual({ name: 'note.mp3', mimeType: 'audio/mpeg' })
    expect(files).toHaveLength(1)
    expect(voices).toHaveLength(1)
    expect(files[0]?.name).toBe('photo.jpg')
    expect(voices[0]?.name).toBe('note.mp3')
    expect(JSON.stringify(files[0])).not.toContain(cwd)
    expect(JSON.stringify(voices[0])).not.toContain(cwd)

    dispose()
    expect(registered).toEqual([])
  })
})

describe('Spectrum outbound media content mapping', () => {
  it('builds attachment content for images and voice content for audio', async () => {
    const image = await attachmentForOutbound({
      bytes: Buffer.from('png'),
      name: 'shot.png',
      mimeType: 'image/png',
    }).build()
    expect(image).toMatchObject({ type: 'attachment', name: 'shot.png', mimeType: 'image/png' })
    expect(Buffer.from(await image.read()).toString()).toBe('png')

    const audio = await voiceForOutbound({
      bytes: Buffer.from('mp3'),
      name: 'memo.mp3',
      mimeType: 'audio/mpeg',
    }).build()
    expect(audio).toMatchObject({ type: 'voice', name: 'memo.m4a', mimeType: 'audio/mpeg' })
    expect(Buffer.from(await audio.read()).toString()).toBe('mp3')
  })
})

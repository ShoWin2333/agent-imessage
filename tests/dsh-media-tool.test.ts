import { mkdtemp, mkdir, writeFile, symlink, rm, rename, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { channelMediaTool, type MediaSendResult } from '../src/plugin/media-tool.js'
import { DEFAULT_MAX_OUTBOUND_MEDIA_BYTES, loadOutboundMedia, type OutboundMediaReader } from '../src/media.js'

const hooks = vi.hoisted(() => ({
  afterOpen: undefined as ((handle: FileHandle) => Promise<void>) | undefined,
  afterStat: undefined as (() => Promise<void>) | undefined,
  changedAncestor: undefined as string | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      await hooks.afterOpen?.(handle)
      return handle
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args)
      // Windows cannot replace an ancestor while a descendant handle is open.
      // Simulate that changed entry to exercise the same fail-closed check there.
      if (String(args[0]) === hooks.changedAncestor) return { ...result, isDirectory: () => false, isSymbolicLink: () => true }
      return result
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args)
      await hooks.afterStat?.()
      return result
    },
  }
})

const tempDirs: string[] = []
afterEach(async () => {
  hooks.afterOpen = undefined
  hooks.afterStat = undefined
  hooks.changedAncestor = undefined
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function workspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-media-test-'))
  tempDirs.push(dir)
  return dir
}
function execution(signal = new AbortController().signal): ToolRunContext {
  return { signal } as ToolRunContext
}
const sent: MediaSendResult = { delivery: 'sent', name: 'photo.png', bytes: 3, mode: 'image' }

describe('channel_send_media definition', () => {
  it('has only the required path and kind, with upload and uncertainty guidance', () => {
    const tool = channelMediaTool(vi.fn())
    expect(tool.name).toBe('channel_send_media')
    expect(tool.parameters).toMatchObject({
      type: 'object', required: ['path', 'kind'],
      properties: { path: { type: 'string' }, kind: { enum: ['image', 'file', 'voice'] } },
    })
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(['path', 'kind'])
    expect(tool.description).toMatch(/current channel owner/)
    expect(tool.description).toMatch(/uploads.*externally/)
    expect(tool.description).toMatch(/no speech synthesis/)
    expect(tool.description).toMatch(/uncertain.*do not automatically retry/)
    expect(JSON.stringify(tool.parameters)).toContain('20 MiB')
    expect(tool.isConcurrencySafe).toBeUndefined()
  })

  it.each(['image', 'file', 'voice'] as const)('forwards %s and the exact execution context once', async (kind) => {
    const send = vi.fn(async () => ({ ...sent, mode: kind }))
    const exec = execution()
    const tool = channelMediaTool(send)
    expect(await tool.execute({ path: '  photo.png  ', kind }, exec)).toEqual({ ...sent, mode: kind })
    expect(send).toHaveBeenCalledExactlyOnceWith({ path: 'photo.png', kind }, exec)
  })

  it.each([
    {}, { path: 'x' }, { kind: 'image' }, { path: 4, kind: 'file' },
    { path: 'x', kind: 'audio' }, { path: 'x', kind: 'file', recipient: 'someone' },
    { path: '', kind: 'file' }, { path: '  ', kind: 'file' },
  ])('strictly rejects malformed arguments without sending: %j', async (args) => {
    const send = vi.fn()
    await expect(channelMediaTool(send).execute(args, execution())).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves uncertain delivery without retrying or reporting sent', async () => {
    const value: MediaSendResult = { ...sent, delivery: 'uncertain', reason: 'confirmation unavailable' }
    const send = vi.fn(async () => value)
    const tool = channelMediaTool(send)
    expect(await tool.execute({ path: 'photo.png', kind: 'image' }, execution())).toEqual(value)
    expect(send).toHaveBeenCalledTimes(1)
    expect(tool.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })

  it('propagates sender failure once and never retries', async () => {
    const send = vi.fn(async () => { throw new Error('denied') })
    await expect(channelMediaTool(send).execute({ path: 'x', kind: 'file' }, execution())).rejects.toThrow('denied')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not invoke the sender for an already cancelled execution', async () => {
    const send = vi.fn()
    await expect(channelMediaTool(send).execute({ path: 'x', kind: 'file' }, execution(AbortSignal.abort()))).rejects.toThrow('cancelled')
    expect(send).not.toHaveBeenCalled()
  })

  it('measures the model-facing schema against its zero-tool baseline', () => {
    const { name, description, parameters } = channelMediaTool(vi.fn())
    const schema = JSON.stringify({ name, description, parameters })
    // Exact bytes are stable and reproducible without assuming a model tokenizer.
    console.info(`channel_send_media schema: baseline=0 bytes; after=${Buffer.byteLength(schema)} bytes, ${schema.length} characters; approximate tokens=${Math.ceil(schema.length / 4)}`)
    expect(Buffer.byteLength(schema)).toBeLessThan(1000)
  })
})

describe('workspace outbound media loader', () => {
  async function load(dir: string, rawPath: string, kind: 'file' | 'image' | 'audio' = 'file', maxBytes = 32) {
    return loadOutboundMedia({ rawPath, kind, workspaceCwd: dir, maxBytes, signal: new AbortController().signal })
  }

  it.each([
    ['image', 'photo.PNG', 'image/png'], ['file', 'clip.mp3', 'audio/mpeg'],
    ['audio', 'voice.m4a', 'audio/mp4'], ['file', 'document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['file', 'sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['file', 'slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['file', 'opaque.bin', 'application/octet-stream'],
  ] as const)('loads %s %s with its MIME type', async (kind, name, mimeType) => {
    const dir = await workspace()
    await writeFile(path.join(dir, name), 'abc')
    expect(await load(dir, name, kind)).toEqual({ bytes: Buffer.from('abc'), name, mimeType })
  })

  it('derives the MIME and basename from the canonical file rather than a misleading symlink', async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, 'actual.txt'), 'abc')
    await symlink('actual.txt', path.join(dir, 'pretend.png'))
    await expect(load(dir, 'pretend.png', 'image')).rejects.toThrow('Unsupported image')
    expect(await load(dir, 'pretend.png')).toMatchObject({ name: 'actual.txt', mimeType: 'text/plain' })
  })

  it('allows contained symlinks and rejects outside targets, traversal and sibling-prefix paths', async () => {
    const dir = await workspace()
    const outside = await workspace()
    await writeFile(path.join(dir, 'inside.txt'), 'ok')
    await writeFile(path.join(outside, 'secret.txt'), 'no')
    await symlink('inside.txt', path.join(dir, 'alias.txt'))
    await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'escape.txt'))
    expect((await load(dir, 'alias.txt')).name).toBe('inside.txt')
    await expect(load(dir, 'escape.txt')).rejects.toThrow('outside')
    await expect(load(dir, path.relative(dir, path.join(outside, 'secret.txt')))).rejects.toThrow('outside')
    await expect(load(dir, path.join(outside, 'secret.txt'))).rejects.toThrow('outside')
  })

  it('rejects directories, missing paths, unsupported image/audio and invalid limits', async () => {
    const dir = await workspace()
    await mkdir(path.join(dir, 'folder'))
    await writeFile(path.join(dir, 'plain.txt'), 'x')
    await expect(load(dir, 'folder')).rejects.toThrow('not a regular file')
    await expect(load(dir, 'absent')).rejects.toThrow('not found')
    await expect(load(dir, 'plain.txt', 'image')).rejects.toThrow('Unsupported image')
    await expect(load(dir, 'plain.txt', 'audio')).rejects.toThrow('Unsupported audio')
    await expect(load(dir, 'plain.txt', 'file', -1)).rejects.toThrow('Invalid')
    await expect(load(dir, 'plain.txt', 'file', Number.POSITIVE_INFINITY)).rejects.toThrow('Invalid')
    await expect(load(dir, 'plain.txt', 'file', 0.5)).rejects.toThrow('Invalid')
    await expect(load(dir, ' ')).rejects.toThrow('path is required')
  })

  it('enforces inclusive byte limits and accepts empty files', async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, 'bytes.bin'), 'abc')
    await writeFile(path.join(dir, 'empty.bin'), '')
    expect((await load(dir, 'bytes.bin', 'file', 3)).bytes.length).toBe(3)
    await expect(load(dir, 'bytes.bin', 'file', 2)).rejects.toThrow('size limit')
    expect((await load(dir, 'empty.bin', 'file', 0)).bytes.length).toBe(0)
  })

  it('bounds a growing read to cap plus one byte and closes the handle on failure', async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, 'growing.bin'), '')
    let requested = 0
    let close: ReturnType<typeof vi.spyOn> | undefined
    hooks.afterOpen = async (handle) => {
      close = vi.spyOn(handle, 'close')
      vi.spyOn(handle, 'read').mockImplementation((async (buffer: Buffer, offset: number, length: number) => {
        requested += length
        buffer.fill(1, offset, offset + length)
        return { bytesRead: length, buffer }
      }) as never)
    }
    await expect(load(dir, 'growing.bin', 'file', 128 * 1024)).rejects.toThrow('size limit')
    expect(requested).toBe(128 * 1024 + 1)
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a final-component symlink swap between canonical resolution and open', async () => {
    const dir = await workspace()
    const outside = await workspace()
    await writeFile(path.join(dir, 'race.txt'), 'inside')
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    hooks.afterStat = async () => {
      hooks.afterStat = undefined
      await rename(path.join(dir, 'race.txt'), path.join(dir, 'old.txt'))
      await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'race.txt'))
    }
    await expect(load(dir, 'race.txt')).rejects.toThrow()
  })

  it('rejects an ancestor symlink swap before reading and closes its handle', async () => {
    const dir = await workspace()
    const outside = await workspace()
    await mkdir(path.join(dir, 'folder'))
    await writeFile(path.join(dir, 'folder', 'file.txt'), 'inside')
    let close: ReturnType<typeof vi.spyOn> | undefined
    hooks.afterOpen = async (handle) => {
      close = vi.spyOn(handle, 'close')
      if (process.platform === 'win32') {
        hooks.changedAncestor = await realpath(path.join(dir, 'folder'))
      } else {
        await rename(path.join(dir, 'folder'), path.join(dir, 'old-folder'))
        await symlink(outside, path.join(dir, 'folder'))
      }
    }
    await expect(load(dir, 'folder/file.txt')).rejects.toThrow('directory changed')
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects cancellation before I/O and between bounded reads', async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, 'cancel.bin'), 'abc')
    const controller = new AbortController()
    await expect(loadOutboundMedia({ rawPath: 'cancel.bin', kind: 'file', workspaceCwd: dir, maxBytes: 32, signal: AbortSignal.abort() })).rejects.toThrow('cancelled')
    hooks.afterOpen = async (handle) => {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((async (...args: Parameters<typeof handle.read>) => {
        const result = await read(...args)
        controller.abort()
        return result
      }) as never)
    }
    await expect(loadOutboundMedia({ rawPath: 'cancel.bin', kind: 'file', workspaceCwd: dir, maxBytes: 32, signal: controller.signal })).rejects.toThrow('cancelled')
  })
})

describe('composed filesystem reader', () => {
  function scopedReader() {
    const root = { displayPath: '/workspace', key: Symbol('root') }
    const target = { displayPath: '/workspace/audio.mp3', key: Symbol('file') }
    const reader = {
      resolve: vi.fn(async (rawPath: string) => rawPath === '/workspace' ? root : target),
      processPath: vi.fn((target: { displayPath: string }) => target.displayPath),
      contains: vi.fn(() => true),
      stat: vi.fn(async () => ({ type: 'file' as const, size: 3 })),
      readBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    } satisfies OutboundMediaReader<typeof root>
    const input = { rawPath: 'alias.mp3', kind: 'file' as const, workspaceCwd: '/workspace', signal: new AbortController().signal, maxBytes: 3, reader }
    return { reader, input, root, target }
  }

  it('uses only the composed reader, opaque targets, canonical metadata, cap and cancellation', async () => {
    const { reader, input, root, target } = scopedReader()
    const result = await loadOutboundMedia(input)
    expect(result).toEqual({ bytes: Buffer.from([1, 2, 3]), name: 'audio.mp3', mimeType: 'audio/mpeg' })
    expect(reader.resolve).toHaveBeenNthCalledWith(1, '/workspace', { signal: input.signal })
    expect(reader.resolve).toHaveBeenNthCalledWith(2, 'alias.mp3', { cwd: '/workspace', signal: input.signal })
    expect(reader.contains).toHaveBeenCalledExactlyOnceWith(root, target)
    expect(reader.readBytes).toHaveBeenCalledExactlyOnceWith(target, input.signal, 3)
  })

  it('uses canonical provider processPath rather than an image-looking alias', async () => {
    const { reader, input, target } = scopedReader()
    target.displayPath = '/workspace/pretend.png'
    reader.processPath.mockReturnValue('/workspace/actual.txt')
    await expect(loadOutboundMedia({ ...input, kind: 'image' })).rejects.toThrow('Unsupported image')
    expect(reader.readBytes).not.toHaveBeenCalled()
  })

  it('never falls back to raw fs on provider denial', async () => {
    const { reader, input } = scopedReader()
    reader.readBytes.mockRejectedValue(new Error('FS_PERMISSION_DENIED'))
    await expect(loadOutboundMedia(input)).rejects.toThrow('FS_PERMISSION_DENIED')
    expect(reader.readBytes).toHaveBeenCalledTimes(1)
  })

  it('rejects outside targets before stat/read and directories before read', async () => {
    const { reader, input } = scopedReader()
    reader.contains.mockReturnValue(false)
    await expect(loadOutboundMedia(input)).rejects.toThrow('outside')
    expect(reader.stat).not.toHaveBeenCalled()
    reader.contains.mockReturnValue(true)
    reader.stat.mockResolvedValue({ type: 'directory', size: 3 } as never)
    await expect(loadOutboundMedia(input)).rejects.toThrow('not a regular file')
    expect(reader.readBytes).not.toHaveBeenCalled()
  })

  it('checks both reported and returned byte lengths and hard caps requests at 20 MiB', async () => {
    const { reader, input, target } = scopedReader()
    reader.stat.mockResolvedValue({ type: 'file', size: 4 })
    await expect(loadOutboundMedia(input)).rejects.toThrow('size limit')
    expect(reader.readBytes).not.toHaveBeenCalled()
    reader.stat.mockResolvedValue({ type: 'file', size: 0 })
    reader.readBytes.mockResolvedValue(new Uint8Array(4))
    await expect(loadOutboundMedia(input)).rejects.toThrow('size limit')
    await loadOutboundMedia({ ...input, maxBytes: DEFAULT_MAX_OUTBOUND_MEDIA_BYTES * 2 })
    expect(reader.readBytes).toHaveBeenLastCalledWith(target, input.signal, DEFAULT_MAX_OUTBOUND_MEDIA_BYTES)
  })

  it('does not leak directory components from a Windows display path', async () => {
    const { input, target } = scopedReader()
    target.displayPath = 'C:\\workspace\\audio.mp3'
    expect((await loadOutboundMedia(input)).name).toBe('audio.mp3')
  })
})

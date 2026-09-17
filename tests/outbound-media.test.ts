import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MAX_OUTBOUND_MEDIA_BYTES,
  loadOutboundMedia,
  type OutboundMediaPayload,
} from '../src/media.js'
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

  it('rejects symlink escape outside the workspace', async () => {
    const cwd = await tempWorkspace()
    const outside = await tempWorkspace()
    await writeFile(path.join(outside, 'secret.png'), Buffer.from('secret'))
    await symlink(path.join(outside, 'secret.png'), path.join(cwd, 'alias.png'))
    await expect(loadOutboundMedia({
      rawPath: 'alias.png',
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

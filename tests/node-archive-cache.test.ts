import {createHash} from 'node:crypto'
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
// @ts-expect-error The packaging helper intentionally remains plain ESM.
import {getNodeArchive} from '../scripts/macos/node-archive-cache.mjs'

const bytes = Buffer.from('verified archive fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const identity = {version:'22.23.2', platform:'darwin', arch:'arm64', sha256}
let cacheDirectory: string
const log = vi.fn()
const download = vi.fn(async (_url: string, destination: string) => { await writeFile(destination, bytes) })
const get = (overrides = {}) => getNodeArchive({...identity, cacheDirectory, download, log, ...overrides})

beforeEach(async () => {
  cacheDirectory = await mkdtemp(join(tmpdir(), 'node-cache-test-'))
  download.mockClear()
  log.mockClear()
})
afterEach(async () => { await rm(cacheDirectory, {recursive:true, force:true}) })

describe('verified official Node archive cache', () => {
  it('downloads from the official URL, publishes verified bytes and preserves unrelated files', async () => {
    await writeFile(join(cacheDirectory, 'unrelated'), 'keep')
    const archive = await get()
    expect(download).toHaveBeenCalledWith('https://nodejs.org/dist/v22.23.2/node-v22.23.2-darwin-arm64.tar.gz', expect.stringContaining('/.download-'))
    expect(archive).toBe(join(cacheDirectory, `node-v22.23.2-darwin-arm64-${sha256}.tar.gz`))
    expect(await readFile(archive)).toEqual(bytes)
    expect(await readdir(cacheDirectory)).toEqual(expect.arrayContaining(['unrelated']))
    expect((await readdir(cacheDirectory)).some(name => name.startsWith('.download-'))).toBe(false)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stored (SHA-256 verified)'))
  })

  it('revalidates a cache hit without downloading', async () => {
    const archive = await get()
    download.mockClear()
    expect(await get()).toBe(archive)
    expect(download).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hit (SHA-256 verified)'))
  })

  it('redownloads a corrupted cache entry', async () => {
    const archive = await get()
    await writeFile(archive, 'corrupted')
    expect(await get()).toBe(archive)
    expect(download).toHaveBeenCalledTimes(2)
    expect(await readFile(archive)).toEqual(bytes)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid archive; redownloading'))
  })

  it('cleans only its partial download after a network failure and can retry', async () => {
    await writeFile(join(cacheDirectory, 'unrelated'), 'keep')
    await expect(get({download:async (_url: string, destination: string) => {
      await writeFile(destination, 'partial')
      throw new Error('download interrupted')
    }})).rejects.toThrow('download interrupted')
    expect(await readdir(cacheDirectory)).toEqual(['unrelated'])
    await get()
    expect(await readFile(join(cacheDirectory, 'unrelated'), 'utf8')).toBe('keep')
  })

  it('never publishes a download with a mismatched checksum', async () => {
    await expect(get({download:async (_url: string, destination: string) => { await writeFile(destination, 'wrong') }})).rejects.toThrow('checksum mismatch')
    expect(await readdir(cacheDirectory)).toEqual([])
    const archive = await get()
    await writeFile(archive, 'old invalid archive')
    await expect(get({download:async (_url: string, destination: string) => { await writeFile(destination, 'wrong') }})).rejects.toThrow('checksum mismatch')
    expect(await readFile(archive, 'utf8')).toBe('old invalid archive')
  })

  it('isolates version, platform, architecture and expected checksum', async () => {
    const otherBytes = Buffer.from('new archive')
    const otherHash = createHash('sha256').update(otherBytes).digest('hex')
    const paths = await Promise.all([
      get(), get({version:'24.0.0'}), get({platform:'linux'}), get({arch:'x64'}),
      get({sha256:otherHash, download:async (_url: string, destination: string) => { await writeFile(destination, otherBytes) }}),
    ])
    expect(new Set(paths).size).toBe(5)
    for (const archive of paths) expect(await readFile(archive)).toEqual(archive.includes(otherHash) ? otherBytes : bytes)
  })

  it('does not expose partial archives during concurrent downloads', async () => {
    let started = 0
    let release!: () => void
    let bothStarted!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { bothStarted = resolve })
    const concurrentDownload = async (_url: string, destination: string) => {
      await writeFile(destination, 'partial')
      if (++started === 2) bothStarted()
      await gate
      await writeFile(destination, bytes)
    }
    const pending = Promise.all([get({download:concurrentDownload}), get({download:concurrentDownload})])
    await ready
    try {
      expect((await readdir(cacheDirectory)).every(name => name.startsWith('.download-'))).toBe(true)
    } finally { release() }
    const [first, second] = await pending
    expect(first).toBe(second)
    expect(await readFile(first)).toEqual(bytes)
    expect(await readdir(cacheDirectory)).toEqual([first.split('/').at(-1)])
  })

  it('replaces a cache symlink without touching its target', async () => {
    const archive = await get()
    await rm(archive)
    const target = join(cacheDirectory, 'unrelated')
    await writeFile(target, 'keep')
    await symlink(target, archive)
    await get()
    expect(await readFile(target, 'utf8')).toBe('keep')
    expect(await readFile(archive)).toEqual(bytes)
  })

  it.each([{version:'../22.23.2'}, {platform:'../darwin'}, {arch:'arm64/../../'}, {sha256:'invalid'}])('rejects unsafe cache identity %j', async overrides => {
    await expect(get(overrides)).rejects.toThrow('Invalid Node archive cache identity')
    expect(download).not.toHaveBeenCalled()
    expect(await readdir(cacheDirectory)).toEqual([])
  })
})

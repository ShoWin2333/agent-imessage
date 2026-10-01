import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {lstat, mkdir, mkdtemp, rename, rm} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

export function defaultNodeCacheDirectory() {
  return process.env.AGENT_GATEWAY_NODE_CACHE_DIR || join(homedir(), 'Library', 'Caches', 'agent-imessage', 'node')
}

async function verified(path, expected) {
  try {
    if (!(await lstat(path)).isFile()) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === expected
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function downloadOfficialArchive(url, destination) {
  execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--output', destination, url], {stdio:'inherit'})
}

// Each writer owns its temporary directory. Only a verified complete archive is
// atomically published; concurrent writers may download the same valid bytes.
export async function getNodeArchive({version, platform, arch, sha256, cacheDirectory = defaultNodeCacheDirectory(), download = downloadOfficialArchive, log = console.log}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9_]+$/.test(arch) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid Node archive cache identity')
  }
  const directory = resolve(cacheDirectory)
  const archiveName = `node-v${version}-${platform}-${arch}`
  const archive = join(directory, `${archiveName}-${sha256}.tar.gz`)
  if (await verified(archive, sha256)) {
    log(`[Node cache] hit (SHA-256 verified): ${archive}`)
    return archive
  }
  let present = false
  try { await lstat(archive); present = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  log(`[Node cache] ${present ? 'invalid archive; redownloading' : 'miss; downloading'}: ${archive}`)
  await mkdir(directory, {recursive:true, mode:0o700})
  const work = await mkdtemp(join(directory, '.download-'))
  try {
    const temporary = join(work, 'node.tar.gz')
    await download(`https://nodejs.org/dist/v${version}/${archiveName}.tar.gz`, temporary)
    if (!(await verified(temporary, sha256))) throw new Error('Node archive checksum mismatch')
    await rename(temporary, archive)
    log(`[Node cache] stored (SHA-256 verified): ${archive}`)
    return archive
  } finally {
    await rm(work, {recursive:true, force:true})
  }
}

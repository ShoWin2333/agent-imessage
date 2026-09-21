import { describe, expect, it } from 'vitest'
import { chunkText } from '../src/chunks.js'
import {
  parsePhotonCredential,
  serializePhotonCredential,
  type PhotonCredential,
} from '../src/credential.js'
import { publicError } from '../src/errors.js'
import { normalizeE164 } from '../src/phone.js'
import { createSecureFetch } from '../src/secure-fetch.js'

const credential: PhotonCredential = {
  version: 2,
  apiOrigin: 'https://app.photon.codes',
  accessToken: 'management-token-secret',
  accessTokenExpiresAt: 2_000_000_000_000,
  account: { id: 'account-1', email: 'user@example.com', name: 'Dsh User' },
  projects: [{ id: 'project-1', name: 'dsh', secret: 'project-secret' }],
}

describe('public primitives', () => {
  it('strictly normalizes E.164 and rejects formatting or oversized values', () => {
    expect(normalizeE164('  +14155552671 ')).toBe('+14155552671')
    expect(normalizeE164('+12')).toBe('+12')
    for (const invalid of ['4155552671', '+01', '+1 415 555 2671', '+1234567890123456']) {
      expect(() => normalizeE164(invalid)).toThrowError(expect.objectContaining({ code: 'invalid-phone' }))
    }
  })

  it('chunks at paragraph boundaries and never splits grapheme clusters', () => {
    expect(chunkText('one paragraph\n\ntwo paragraph', 16)).toEqual(['one paragraph', 'two paragraph'])
    expect(chunkText('header\n    indented', 8)).toEqual(['header', '    inde', 'nted'])
    const family = '👨‍👩‍👧‍👦'
    expect(chunkText(`${family}${family}`, 1)).toEqual([family, family])
    expect(chunkText('', 10)).toEqual([])
  })

  it('round-trips the one opaque credential and redacts unknown failures', () => {
    expect(parsePhotonCredential(serializePhotonCredential(credential))).toEqual(credential)
    expect(parsePhotonCredential(JSON.stringify({
      version: 1,
      apiOrigin: 'https://app.photon.codes',
      accessToken: 'management-token-secret',
      accessTokenExpiresAt: 2_000_000_000_000,
      account: { id: 'account-1', email: 'user@example.com', name: 'Dsh User' },
      project: { id: 'project-1', name: 'dsh', secret: 'project-secret' },
    }))).toEqual(credential)
    const safe = publicError(new Error(`failure ${credential.accessToken} ${credential.projects[0]?.secret}`))
    expect(JSON.stringify(safe)).not.toContain(credential.accessToken)
    expect(JSON.stringify(safe)).not.toContain(credential.projects[0]?.secret)
    expect(safe.code).toBe('internal-error')
  })

  it('rejects cross-origin requests and follows one same-origin redirect', async () => {
    const observed: Array<{ url: string; redirect?: RequestRedirect }> = []
    const implementation = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      observed.push({ url, redirect: init?.redirect })
      if (url === 'https://app.photon.codes/api/projects') {
        return new Response(null, {
          status: 308,
          headers: { Location: 'https://app.photon.codes/api/projects/' },
        })
      }
      return new Response('ok', { status: 200 })
    }
    const secure = createSecureFetch('https://app.photon.codes', implementation as typeof fetch)
    await expect(secure('https://app.photon.codes/api/projects')).resolves.toMatchObject({ status: 200 })
    expect(observed).toEqual([
      { url: 'https://app.photon.codes/api/projects', redirect: 'manual' },
      { url: 'https://app.photon.codes/api/projects/', redirect: 'error' },
    ])
    await expect(secure('https://attacker.example/token')).rejects.toThrow('cross-origin')

    const evil = createSecureFetch('https://app.photon.codes', (async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/steal' },
    })) as typeof fetch)
    await expect(evil('https://app.photon.codes/api/projects')).rejects.toThrow('cross-origin')
  })
})

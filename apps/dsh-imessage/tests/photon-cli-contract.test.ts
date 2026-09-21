import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  DEVICE_GRANT_TYPE,
  PHOTON_DEVICE_CLIENT_ID,
  PHOTON_DEVICE_SCOPE,
} from '../src/constants.js'

interface Contract {
  repository: string
  source: string
  commit: string
  clientId: string
  scope: string
  grantType: string
  slowDownSeconds: number
  rateLimitSeconds: number
  errorCodes: string[]
}

describe('Photon CLI device-login compatibility exception', () => {
  it('pins the shared contract to the audited upstream login implementation', async () => {
    const source = await readFile(new URL('../contracts/photon-cli-login.contract.json', import.meta.url), 'utf8')
    const contract = JSON.parse(source) as Contract
    expect(contract).toMatchObject({
      repository: 'https://github.com/photon-hq/cli',
      source: 'src/commands/login.ts',
      commit: '13fb65a3f33e801cb50f7e7a240a8eb6466c4152',
      clientId: PHOTON_DEVICE_CLIENT_ID,
      scope: PHOTON_DEVICE_SCOPE,
      grantType: DEVICE_GRANT_TYPE,
      slowDownSeconds: 5,
      rateLimitSeconds: 10,
    })
    expect(contract.errorCodes).toEqual(expect.arrayContaining([
      'authorization_pending', 'slow_down', 'access_denied', 'expired_token',
    ]))
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  authorizeDevice,
  createPhotonDeviceAuthApi,
  type DeviceAuthApi,
  type DeviceTokenPoll,
} from '../src/device-auth.js'

function fakeApi(polls: DeviceTokenPoll[]): DeviceAuthApi {
  return {
    requestCode: vi.fn(async () => ({
      deviceCode: 'host-only-device-code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://app.photon.codes/device',
      verificationUriComplete: 'https://app.photon.codes/device?user_code=ABCD-EFGH',
      intervalSeconds: 2,
      expiresInSeconds: 300,
    })),
    pollToken: vi.fn(async () => polls.shift() ?? { kind: 'expired' }),
    getIdentity: vi.fn(async () => ({ id: 'account-1', email: 'user@example.com' })),
  }
}

describe('Photon device authorization', () => {
  it('keeps the Photon CLI wire contract with the patched Better Auth client', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      jsonResponse({
        device_code: 'device-private',
        user_code: 'USER-CODE',
        verification_uri: 'https://app.photon.codes/device',
        interval: 5,
        expires_in: 1_800,
      }),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ access_token: 'management-token', expires_in: 3_600 }),
      jsonResponse({
        session: { id: 'session' },
        user: { id: 'account', email: 'user@example.com', name: 'Photon User' },
      }),
    ]
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), ...(init === undefined ? {} : { init }) })
      const response = responses.shift()
      if (response === undefined) throw new Error('unexpected request')
      return response
    }) as unknown as typeof fetch
    const api = createPhotonDeviceAuthApi('https://app.photon.codes', fetchImpl)

    await expect(api.requestCode()).resolves.toMatchObject({
      deviceCode: 'device-private', userCode: 'USER-CODE', intervalSeconds: 5, expiresInSeconds: 1_800,
    })
    await expect(api.pollToken('device-private')).resolves.toEqual({ kind: 'pending' })
    await expect(api.pollToken('device-private')).resolves.toEqual({
      kind: 'token', accessToken: 'management-token', expiresInSeconds: 3_600,
    })
    await expect(api.getIdentity('management-token')).resolves.toEqual({
      id: 'account', email: 'user@example.com', name: 'Photon User',
    })

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/api/auth/device/code', '/api/auth/device/token', '/api/auth/device/token', '/api/auth/get-session',
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      client_id: 'photon-cli', scope: 'openid profile email',
    })
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'device-private',
      client_id: 'photon-cli',
    })
    expect(new Headers(calls[3]?.init?.headers).get('Authorization')).toBe('Bearer management-token')
    expect(calls.every(call => call.init?.redirect === 'manual' || call.init?.redirect === 'error')).toBe(true)
  })

  it('publishes only public code data and applies pending/slow_down/429 backoff', async () => {
    const api = fakeApi([
      { kind: 'pending' },
      { kind: 'slow-down' },
      { kind: 'rate-limited' },
      { kind: 'token', accessToken: 'host-token', expiresInSeconds: 3_600 },
    ])
    const sleeps: number[] = []
    let now = 1_000
    const onCode = vi.fn()
    const result = await authorizeDevice(api, {
      signal: new AbortController().signal,
      now: () => now,
      sleep: async milliseconds => {
        sleeps.push(milliseconds)
        now += milliseconds
      },
      onCode,
    })

    expect(sleeps).toEqual([2_000, 2_000, 7_000, 17_000])
    expect(onCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://app.photon.codes/device',
      verificationUriComplete: 'https://app.photon.codes/device?user_code=ABCD-EFGH',
      expiresAt: 301_000,
    })
    expect(JSON.stringify(onCode.mock.calls)).not.toContain('host-only-device-code')
    expect(result.accessToken).toBe('host-token')
    expect(result.expiresAt).toBe(now + 3_600_000)
  })

  it.each([
    ['denied', 'auth-denied'],
    ['expired', 'auth-expired'],
  ] as const)('maps %s to a stable public error', async (kind, code) => {
    await expect(authorizeDevice(fakeApi([{ kind }]), {
      signal: new AbortController().signal,
      sleep: async () => {},
      onCode: () => {},
    })).rejects.toMatchObject({ code })
  })

  it('honors cancellation before requesting a device code', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))
    const api = fakeApi([])
    await expect(authorizeDevice(api, {
      signal: controller.signal,
      onCode: () => {},
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.requestCode).not.toHaveBeenCalled()
  })

  it('caps the final sleep at expiry and never polls an expired device code', async () => {
    let now = 1_000
    const pollToken = vi.fn(async (): Promise<DeviceTokenPoll> => ({ kind: 'pending' }))
    const api: DeviceAuthApi = {
      requestCode: async () => ({
        deviceCode: 'private',
        userCode: 'PUBLIC',
        verificationUri: 'https://app.photon.codes/device',
        intervalSeconds: 5,
        expiresInSeconds: 3,
      }),
      pollToken,
      getIdentity: async () => ({ id: 'account', email: 'user@example.com' }),
    }
    const sleeps: number[] = []
    await expect(authorizeDevice(api, {
      signal: new AbortController().signal,
      now: () => now,
      sleep: async milliseconds => { sleeps.push(milliseconds); now += milliseconds },
      onCode: () => {},
    })).rejects.toMatchObject({ code: 'auth-expired' })
    expect(sleeps).toEqual([3_000])
    expect(pollToken).not.toHaveBeenCalled()
  })

  it('rejects a cross-origin verification URL before exposing it to the browser', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      device_code: 'private',
      user_code: 'PUBLIC',
      verification_uri: 'https://attacker.example/device',
      interval: 5,
      expires_in: 1_800,
    })) as unknown as typeof fetch
    const api = createPhotonDeviceAuthApi('https://app.photon.codes', fetchImpl)
    await expect(api.requestCode()).rejects.toMatchObject({ code: 'photon-unavailable' })
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

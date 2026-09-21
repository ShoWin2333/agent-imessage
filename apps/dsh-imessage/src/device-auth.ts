import { createAuthClient } from 'better-auth/client'
import { deviceAuthorizationClient } from 'better-auth/client/plugins'
import {
  DEVICE_GRANT_TYPE,
  PHOTON_DEVICE_CLIENT_ID,
  PHOTON_DEVICE_SCOPE,
} from './constants.js'
import { PluginError } from './errors.js'
import { createSecureFetch } from './secure-fetch.js'
import type { PhotonAccountView } from './types.js'

/** Public half of a pending Photon device authorization. */
export interface DeviceCodeView {
  /** User-facing short code. */
  userCode: string
  /** Base verification page. */
  verificationUri: string
  /** Verification page with code prefilled. */
  verificationUriComplete?: string
  /** Absolute Unix expiry time in milliseconds. */
  expiresAt: number
}

/** Private Photon device code and polling policy. */
export interface DeviceCodeGrant extends DeviceCodeView {
  /** Host-only opaque device code. */
  deviceCode: string
  /** Initial poll interval in seconds. */
  intervalSeconds: number
}

/** Successful Photon device authorization. */
export interface DeviceAuthorizationResult {
  /** Host-only management access token. */
  accessToken: string
  /** Absolute Unix token expiry in milliseconds. */
  expiresAt: number
  /** Public Photon identity. */
  account: PhotonAccountView
}

/** Normalized device-token poll response. */
export type DeviceTokenPoll =
  | { kind: 'pending' }
  | { kind: 'slow-down' }
  | { kind: 'rate-limited' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'token'; accessToken: string; expiresInSeconds: number }

/** Injectable Photon device-auth transport used by production and contract tests. */
export interface DeviceAuthApi {
  /** Request a new device code. */
  requestCode(): Promise<{
    deviceCode: string
    userCode: string
    verificationUri: string
    verificationUriComplete?: string
    intervalSeconds: number
    expiresInSeconds: number
  }>
  /** Poll one device code. */
  pollToken(deviceCode: string): Promise<DeviceTokenPoll>
  /** Fetch the identity associated with a newly issued bearer token. */
  getIdentity(accessToken: string): Promise<PhotonAccountView>
}

/** Options controlling one RFC 8628 polling loop. */
export interface DeviceAuthorizationOptions {
  /** Abort signal used by cancel, teardown, and replacement authorization. */
  signal: AbortSignal
  /** Called as soon as a public device code is available. */
  onCode(code: DeviceCodeView): void
  /** Overridable clock for deterministic tests. */
  now?: () => number
  /** Overridable abortable sleep for deterministic tests. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/** Execute Photon CLI's current RFC 8628 contract without reading CLI files. */
export async function authorizeDevice(
  api: DeviceAuthApi,
  options: DeviceAuthorizationOptions,
): Promise<DeviceAuthorizationResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep
  assertNotAborted(options.signal)
  const code = await api.requestCode()
  assertNotAborted(options.signal)

  const expiresAt = now() + code.expiresInSeconds * 1_000
  options.onCode({
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    ...(code.verificationUriComplete === undefined
      ? {}
      : { verificationUriComplete: code.verificationUriComplete }),
    expiresAt,
  })

  let intervalSeconds = code.intervalSeconds
  while (now() < expiresAt) {
    const remaining = expiresAt - now()
    await sleep(Math.min(intervalSeconds * 1_000, remaining), options.signal)
    assertNotAborted(options.signal)
    if (now() >= expiresAt) break
    const result = await api.pollToken(code.deviceCode)
    assertNotAborted(options.signal)
    switch (result.kind) {
      case 'pending':
        continue
      case 'slow-down':
        intervalSeconds += 5
        continue
      case 'rate-limited':
        intervalSeconds += 10
        continue
      case 'denied':
        throw new PluginError('auth-denied', 'Photon authorization was denied.')
      case 'expired':
        throw new PluginError('auth-expired', 'Photon authorization expired. Start again.')
      case 'token': {
        const account = await api.getIdentity(result.accessToken)
        assertNotAborted(options.signal)
        return {
          accessToken: result.accessToken,
          expiresAt: now() + result.expiresInSeconds * 1_000,
          account,
        }
      }
    }
  }
  throw new PluginError('auth-expired', 'Photon authorization expired. Start again.')
}

type BetterAuthResponse<T> = {
  data?: T | null
  error?: unknown
}

type BetterAuthError = {
  error?: unknown
  status?: unknown
  message?: unknown
  statusText?: unknown
}

/** Production adapter pinned to the Photon CLI Better Auth device plugin contract. */
export function createPhotonDeviceAuthApi(origin: string, fetchImpl: typeof fetch = fetch): DeviceAuthApi {
  const allowedOrigin = new URL(origin).origin
  const auth = createAuthClient({
    baseURL: allowedOrigin,
    disableDefaultFetchPlugins: true,
    fetchOptions: { customFetchImpl: createSecureFetch(allowedOrigin, fetchImpl) },
    plugins: [deviceAuthorizationClient()],
  })

  return {
    async requestCode() {
      const response = await auth.device.code({
        client_id: PHOTON_DEVICE_CLIENT_ID,
        scope: PHOTON_DEVICE_SCOPE,
      }) as BetterAuthResponse<{
        device_code: string
        user_code: string
        verification_uri: string
        verification_uri_complete?: string
        interval?: number
        expires_in?: number
      }>
      const data = expectData(response, 'Could not start Photon device authorization.')
      const deviceCode = requiredString(data.device_code, 'Photon returned an invalid device code.')
      const userCode = requiredString(data.user_code, 'Photon returned an invalid user code.')
      const verificationUri = verificationUrl(
        data.verification_uri,
        allowedOrigin,
        'Photon returned an invalid verification URL.',
      )
      const verificationUriComplete = data.verification_uri_complete === undefined
        ? undefined
        : verificationUrl(
          data.verification_uri_complete,
          allowedOrigin,
          'Photon returned an invalid complete verification URL.',
        )
      return {
        deviceCode,
        userCode,
        verificationUri,
        ...(verificationUriComplete === undefined
          ? {}
          : { verificationUriComplete }),
        intervalSeconds: positiveSeconds(data.interval, 5, 'Photon returned an invalid polling interval.'),
        expiresInSeconds: positiveSeconds(data.expires_in, 1_800, 'Photon returned an invalid device-code expiry.'),
      }
    },
    async pollToken(deviceCode) {
      const response = await auth.device.token({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: PHOTON_DEVICE_CLIENT_ID,
      }) as BetterAuthResponse<{ access_token?: string; expires_in?: number }>
      if (response.data?.access_token) {
        return {
          kind: 'token',
          accessToken: requiredString(response.data.access_token, 'Photon returned an invalid access token.'),
          expiresInSeconds: positiveSeconds(
            response.data.expires_in,
            3_600,
            'Photon returned an invalid access-token expiry.',
          ),
        }
      }
      const error = response.error as BetterAuthError | undefined
      const code = typeof error?.error === 'string' ? error.error : undefined
      const status = typeof error?.status === 'number' ? error.status : undefined
      if (status === 429) return { kind: 'rate-limited' }
      if (code === 'authorization_pending') return { kind: 'pending' }
      if (code === 'slow_down') return { kind: 'slow-down' }
      if (code === 'access_denied') return { kind: 'denied' }
      if (code === 'expired_token') return { kind: 'expired' }
      throw new PluginError('photon-unavailable', 'Photon device authorization failed. Retry shortly.')
    },
    async getIdentity(accessToken) {
      const response = await auth.getSession({
        fetchOptions: { headers: { Authorization: `Bearer ${accessToken}` } },
      }) as BetterAuthResponse<{ user?: { id?: string; email?: string; name?: string | null } }>
      const user = response.data?.user
      if (!user?.id || !user.email) {
        throw new PluginError(
          'photon-unavailable',
          'Photon issued a token but did not return an account identity.',
        )
      }
      return {
        id: user.id,
        email: user.email,
        ...(typeof user.name === 'string' && user.name.trim().length > 0 ? { name: user.name.trim() } : {}),
      }
    },
  }
}

function expectData<T>(response: BetterAuthResponse<T>, message: string): T {
  if (response.data !== undefined && response.data !== null) return response.data
  throw new PluginError('photon-unavailable', message)
}

function requiredString(value: unknown, message: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw new PluginError('photon-unavailable', message)
}

function positiveSeconds(value: unknown, fallback: number, message: string): number {
  const candidate = value ?? fallback
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate
  throw new PluginError('photon-unavailable', message)
}

function verificationUrl(value: unknown, origin: string, message: string): string {
  if (typeof value !== 'string') throw new PluginError('photon-unavailable', message)
  try {
    const url = new URL(value)
    if (url.origin !== origin) throw new Error('cross-origin verification URL')
    return url.href
  } catch {
    throw new PluginError('photon-unavailable', message)
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      return
    }
    const complete = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(complete, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

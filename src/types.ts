/** Stable failures that are safe to render in the settings UI or iMessage. */
export type PluginErrorCode =
  | 'invalid-phone'
  | 'invalid-workspace'
  | 'invalid-project-name'
  | 'auth-expired'
  | 'auth-denied'
  | 'authorization-required'
  | 'project-ambiguous'
  | 'user-ambiguous'
  | 'user-resolution-required'
  | 'shared-line-unavailable'
  | 'credential-readonly'
  | 'settings-readonly'
  | 'settings-conflict'
  | 'runtime-failed'
  | 'photon-unavailable'
  | 'busy'
  | 'request-not-found'
  | 'invalid-command'
  | 'internal-error'

/** Redacted failure sent across the RPC boundary. */
export interface PublicPluginError {
  /** Stable machine-readable code. */
  code: PluginErrorCode
  /** Human-readable message containing no secrets or message content. */
  message: string
  /** Optional public identifiers needed for manual resolution. */
  details?: string[]
}

/** Public Photon identity metadata. */
export interface PhotonAccountView {
  /** Photon account id. */
  id: string
  /** Account email address. */
  email: string
  /** Display name, when Photon supplies one. */
  name?: string
}

/** Spectrum is locally stopped. */
export interface RuntimeStopped {
  /** Discriminator for a stopped runtime. */
  phase: 'stopped'
}

/** Spectrum is starting. */
export interface RuntimeStarting {
  /** Discriminator for a starting runtime. */
  phase: 'starting'
}

/** Spectrum is actively listening for the assigned hosted line. */
export interface RuntimeListening {
  /** Discriminator for a healthy runtime. */
  phase: 'listening'
  /** Unix time in milliseconds when the listener became healthy. */
  connectedAt: number
}

/** Spectrum is waiting before an automatic reconnect. */
export interface RuntimeRetrying {
  /** Discriminator for reconnect backoff. */
  phase: 'retrying'
  /** One-based reconnect attempt. */
  attempt: number
  /** Unix time in milliseconds when the next start will be attempted. */
  retryAt: number
}

/** Spectrum exhausted or encountered a non-recoverable local failure. */
export interface RuntimeFailed {
  /** Discriminator for a failed runtime. */
  phase: 'failed'
  /** Redacted runtime failure. */
  error: PublicPluginError
}

/** Complete public Spectrum runtime state. */
export type RuntimeView =
  | RuntimeStopped
  | RuntimeStarting
  | RuntimeListening
  | RuntimeRetrying
  | RuntimeFailed

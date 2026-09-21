import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ImessagePluginState,
  MutationResult,
  PublicPluginError,
} from '../types.js'
// Pulls the generated namespace declaration into TypertClientRemote.
import type {} from 'dsh-imessage/remote'

type ImessageRemote = TypertClientRemote['dshPhotonImessage']

/** Browser-only load and mutation state for the settings section. */
export interface ImessageClientSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  state?: ImessagePluginState
  pendingAction?:
    | 'authorize'
    | 'cancel'
    | 'upsert-route'
    | 'remove-route'
    | 'save-route-phone'
    | 'disconnect'
    | 'retry-route-runtime'
    | 'save-workspace'
    | 'save-phone'
    | 'retry-runtime'
  error?: PublicPluginError
}

type Listener = () => void

/** Minimal observable controller injected into the React settings slot. */
export class ImessageSettingsController {
  private snapshot: ImessageClientSnapshot = { phase: 'idle' }
  private readonly listeners = new Set<Listener>()
  private refreshTask: Promise<ImessagePluginState | undefined> | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private mutationGeneration = 0

  constructor(private readonly remote: ImessageRemote) {}

  /** Stable uSES snapshot read. */
  getSnapshot = (): ImessageClientSnapshot => this.snapshot

  /** Start refresh polling only while a settings surface is mounted. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.schedulePoll()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.clearPoll()
    }
  }

  /** Read a fresh public projection from the host. */
  refresh(): Promise<ImessagePluginState | undefined> {
    if (this.snapshot.pendingAction !== undefined) return Promise.resolve(this.snapshot.state)
    if (this.refreshTask !== undefined) return this.refreshTask
    if (this.snapshot.state === undefined) this.publish({ phase: 'loading' })
    const generation = this.mutationGeneration
    const task = this.remote.getState()
      .then((result) => {
        if (generation !== this.mutationGeneration) return this.snapshot.state
        if (!result.ok) throw new RemoteTransportError()
        this.publish({ phase: 'ready', state: result.value })
        return result.value
      })
      .catch(() => {
        if (generation !== this.mutationGeneration) return this.snapshot.state
        this.publish({
          phase: 'error',
          ...(this.snapshot.state === undefined ? {} : { state: this.snapshot.state }),
          error: connectionError(),
        })
        return undefined
      })
      .finally(() => {
        if (this.refreshTask === task) this.refreshTask = undefined
        this.schedulePoll()
      })
    this.refreshTask = task
    return task
  }

  /** Begin Photon device authorization. */
  beginAuthorization(): Promise<MutationResult | undefined> {
    return this.mutate('authorize', () => this.remote.beginAuthorization())
  }

  /** Cancel only the active device-code poll. */
  cancelAuthorization(): Promise<MutationResult | undefined> {
    return this.mutate('cancel', () => this.remote.cancelAuthorization())
  }

  /** Create or update one local route. */
  upsertRoute(input: {
    id?: string
    label?: string
    workspaceCwd: string
    photonProjectName: string
    expectedRevision: number
  }): Promise<MutationResult | undefined> {
    return this.mutate('upsert-route', () => this.remote.upsertRoute(input))
  }

  /** Remove one local route. */
  removeRoute(routeId: string, expectedRevision: number): Promise<MutationResult | undefined> {
    return this.mutate('remove-route', () => this.remote.removeRoute({ routeId, expectedRevision }))
  }

  /** Provision a sender phone for one route. */
  saveRoutePhone(
    routeId: string,
    phoneNumber: string,
    expectedRevision: number,
  ): Promise<MutationResult | undefined> {
    return this.mutate('save-route-phone', () => this.remote.saveRoutePhone({
      routeId,
      phoneNumber,
      expectedRevision,
    }))
  }

  /** Remove local configuration without deleting Photon resources. */
  disconnect(expectedRevision: number): Promise<MutationResult | undefined> {
    return this.mutate('disconnect', () => this.remote.disconnect({ expectedRevision }))
  }

  /** Restart one route's Spectrum listener. */
  retryRouteRuntime(routeId: string): Promise<MutationResult | undefined> {
    return this.mutate('retry-route-runtime', () => this.remote.retryRouteRuntime({ routeId }))
  }

  /** Release browser timers; the generated Remote contribution is owned by apply(). */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.clearPoll()
  }

  private async mutate(
    action: NonNullable<ImessageClientSnapshot['pendingAction']>,
    operation: () => ReturnType<ImessageRemote['beginAuthorization']>,
  ): Promise<MutationResult | undefined> {
    if (this.snapshot.pendingAction !== undefined) return undefined
    this.mutationGeneration += 1
    const previous = this.snapshot
    this.publish({
      phase: previous.state === undefined ? 'loading' : 'ready',
      ...(previous.state === undefined ? {} : { state: previous.state }),
      pendingAction: action,
    })
    try {
      const response = await operation()
      if (!response.ok) throw new RemoteTransportError()
      const result = response.value
      this.publish({
        phase: 'ready',
        state: result.state,
        ...(result.ok ? {} : { error: result.error }),
      })
      return result
    } catch {
      this.publish({
        phase: 'error',
        ...(previous.state === undefined ? {} : { state: previous.state }),
        error: connectionError(),
      })
      return undefined
    } finally {
      this.schedulePoll()
    }
  }

  private publish(snapshot: ImessageClientSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }

  private schedulePoll(): void {
    this.clearPoll()
    if (this.disposed || this.listeners.size === 0 || this.snapshot.pendingAction !== undefined) return
    const state = this.snapshot.state
    const transient = state?.authorization.phase === 'pending'
      || state?.provisioning.phase === 'project'
      || state?.provisioning.phase === 'user'
      || state?.routes.some(route => route.runtime.phase === 'starting' || route.runtime.phase === 'retrying')
    this.pollTimer = setTimeout(() => { void this.refresh() }, transient ? 1_000 : 5_000)
  }

  private clearPoll(): void {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }
}

class RemoteTransportError extends Error {}

function connectionError(): PublicPluginError {
  return {
    code: 'internal-error',
    message: 'The DSH host connection could not complete this request. Reconnect and try again.',
  }
}

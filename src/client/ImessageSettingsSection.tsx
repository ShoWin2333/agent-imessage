import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ImessagePluginState,
  ImessageRouteState,
  PublicPluginError,
  RuntimeView,
} from '../types.js'
import { isAbsolutePathShape, unwrapCopiedPath } from '../path-shape.js'
import type { ImessageSettingsController } from './controller.js'

/** Dependencies supplied by the client slot registration. */
export interface ImessageSettingsInjected {
  controller: ImessageSettingsController
}

/** Slot props are partial until the renderer has resolved every injected seat. */
export type ImessageSettingsSectionProps = Partial<ImessageSettingsInjected & SettingsSectionOwnerProps>

/** Render the complete three-stage Photon iMessage setup surface. */
export function ImessageSettingsSection(props: ImessageSettingsSectionProps): ReactNode {
  if (props.controller === undefined) return null
  return <Loaded controller={props.controller} />
}

function Loaded({ controller }: ImessageSettingsInjected): ReactNode {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  if (snapshot.state === undefined) {
    return (
      <section className="dsh-imessage-section" aria-busy={snapshot.phase === 'loading'}>
        <PageHeader />
        {snapshot.error === undefined
          ? <p className="dsh-imessage-muted">Loading iMessage configuration…</p>
          : <ErrorNotice error={snapshot.error} onRetry={() => { void controller.refresh() }} />}
      </section>
    )
  }

  return (
    <section className="dsh-imessage-section" aria-busy={snapshot.pendingAction !== undefined}>
      <PageHeader />
      {snapshot.error === undefined ? null : <ErrorNotice error={snapshot.error} />}
      <AuthorizationCard controller={controller} state={snapshot.state} pending={snapshot.pendingAction} />
      <RoutesPanel controller={controller} state={snapshot.state} pending={snapshot.pendingAction} />
      <p className="dsh-imessage-footnote">
        Each route uses its own Photon project and local workspace directory. The same sender phone can be
        reused across routes. Only iMessage DMs from your saved number are accepted; Photon scopes
        shared-line delivery to each project and routes it through the assigned line. Message text and raw
        phone numbers are not written to plugin logs. Disconnecting clears all local routes; it never deletes
        Photon projects or users.
      </p>
    </section>
  )
}

function PageHeader(): ReactNode {
  return (
    <header className="dsh-imessage-heading">
      <div>
        <p className="dsh-imessage-eyebrow">Photon transport</p>
        <h1>iMessage</h1>
        <p>Connect one or more hosted iMessage lines to DeepSeek Harness.</p>
      </div>
    </header>
  )
}

function AuthorizationCard({
  controller,
  state,
  pending,
}: {
  controller: ImessageSettingsController
  state: ImessagePluginState
  pending: string | undefined
}): ReactNode {
  const authorization = state.authorization
  const isWaiting = authorization.phase === 'pending'
  const [popupBlocked, setPopupBlocked] = useState(false)
  const [copied, setCopied] = useState(false)

  const authorize = (): void => {
    // The blank window must be opened in the click task or browsers will treat it as an unsolicited popup.
    const popup = openAuthorizationWindow()
    setPopupBlocked(popup === null)
    void controller.beginAuthorization().then((result) => {
      if (result === undefined || !result.ok) {
        popup?.close()
        return
      }
      const next = result.state.authorization
      if (next.phase !== 'pending') {
        popup?.close()
        return
      }
      const url = next.verificationUriComplete ?? next.verificationUri
      if (popup !== null && !popup.closed) {
        try {
          popup.opener = null
          popup.location.replace(url)
        } catch {
          setPopupBlocked(true)
        }
      }
    })
  }

  const canMutate = state.settingsWritable && state.credentialWritable && pending === undefined
  return (
    <article className="dsh-imessage-card">
      <CardTitle number="1" title="Authorize Photon" status={authorizationLabel(state)} />
      {authorization.phase === 'authorized' ? (
        <p className="dsh-imessage-body">
          Signed in as <strong>{authorization.account.name ?? authorization.account.email}</strong>. Each
          route can use its own Photon project name.
        </p>
      ) : authorization.phase === 'reauthorization-required' ? (
        <p className="dsh-imessage-warning">
          Management authorization expired. Existing routing can keep using the stored project secret, but
          configuration changes require authorization again.
        </p>
      ) : authorization.phase === 'failed' ? (
        <ErrorNotice error={authorization.error} />
      ) : authorization.phase === 'disconnected' ? (
        <p className="dsh-imessage-body">
          Use Photon’s device login. DSH never launches the Photon CLI or reads its credential files.
        </p>
      ) : null}

      {isWaiting ? (
        <div className="dsh-imessage-device" aria-live="polite">
          <span className="dsh-imessage-label">Device code</span>
          <strong className="dsh-imessage-code">{authorization.userCode}</strong>
          <Expiry expiresAt={authorization.expiresAt} />
          <div className="dsh-imessage-actions">
            <a
              className="dsh-imessage-button dsh-imessage-primary"
              href={authorization.verificationUriComplete ?? authorization.verificationUri}
              target="_blank"
              rel="noreferrer"
            >
              Open Photon
            </a>
            <button
              type="button"
              className="dsh-imessage-button"
              onClick={() => {
                void copyText(authorization.userCode).then((ok) => {
                  setCopied(ok)
                  window.setTimeout(() => { setCopied(false) }, 2_000)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
            <button
              type="button"
              className="dsh-imessage-button"
              disabled={pending !== undefined}
              onClick={() => { void controller.cancelAuthorization() }}
            >
              Cancel
            </button>
          </div>
          {popupBlocked ? (
            <p className="dsh-imessage-muted">The popup was blocked. Use “Open Photon” or copy the code.</p>
          ) : null}
        </div>
      ) : (
        <div className="dsh-imessage-actions">
          <button
            type="button"
            className="dsh-imessage-button dsh-imessage-primary"
            disabled={!canMutate}
            onClick={authorize}
          >
            {authorization.phase === 'disconnected' ? 'Authorize' : 'Reauthorize'}
          </button>
        </div>
      )}
      {!state.settingsWritable || !state.credentialWritable ? (
        <p className="dsh-imessage-warning">
          This profile is read-only. Remove the settings or credential override before changing setup.
        </p>
      ) : null}
    </article>
  )
}

function RoutesPanel({
  controller,
  state,
  pending,
}: {
  controller: ImessageSettingsController
  state: ImessagePluginState
  pending: string | undefined
}): ReactNode {
  const canMutate = state.settingsWritable && state.credentialWritable && pending === undefined

  const addRoute = (): void => {
    void controller.upsertRoute({
      label: '',
      workspaceCwd: '',
      photonProjectName: `dsh-route-${Date.now().toString(36)}`,
      expectedRevision: state.revision,
    })
  }

  const disconnect = (): void => {
    if (!window.confirm('Disconnect all local iMessage routes? Photon projects and users will be preserved.')) {
      return
    }
    void controller.disconnect(state.revision)
  }

  return (
    <div className="dsh-imessage-routes">
      {state.routes.map(route => (
        <RouteCard
          key={route.id}
          route={route}
          state={state}
          controller={controller}
          pending={pending}
          canRemove={state.routes.length > 1}
        />
      ))}
      <div className="dsh-imessage-actions">
        <button
          type="button"
          className="dsh-imessage-button dsh-imessage-primary"
          disabled={!canMutate}
          onClick={addRoute}
        >
          {pending === 'upsert-route' ? 'Adding…' : 'Add route'}
        </button>
        <button
          type="button"
          className="dsh-imessage-button dsh-imessage-danger"
          disabled={pending !== undefined || !canMutate}
          onClick={disconnect}
        >
          {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect all routes'}
        </button>
      </div>
    </div>
  )
}

function RouteCard({
  route,
  state,
  controller,
  pending,
  canRemove,
}: {
  route: ImessageRouteState
  state: ImessagePluginState
  controller: ImessageSettingsController
  pending: string | undefined
  canRemove: boolean
}): ReactNode {
  const [label, setLabel] = useState(route.label)
  const [cwd, setCwd] = useState(route.workspaceCwd)
  const [projectName, setProjectName] = useState(route.photonProjectName)
  const [phone, setPhone] = useState(route.phoneNumber ?? '')
  const [routeDirty, setRouteDirty] = useState(false)
  const [phoneDirty, setPhoneDirty] = useState(false)
  const [copied, setCopied] = useState(false)

  const trimmedCwd = unwrapCopiedPath(cwd)
  const trimmedProject = projectName.trim()
  const trimmedLabel = label.trim()
  const normalizedPhone = phone.trim()
  const projectValid = trimmedProject.length === 0 || isPhotonProjectName(trimmedProject)
  const cwdValid = trimmedCwd.length === 0 || isAbsolutePathShape(trimmedCwd)
  const phoneValid = isStrictE164(normalizedPhone)
  const authorized = state.authorization.phase === 'authorized'
  const projectReady = state.provisioning.phase === 'ready'
  const canMutate = state.settingsWritable && state.credentialWritable && pending === undefined
  const assigned = route.assignedPhoneNumber
  const fieldId = route.id.replace(/[^a-zA-Z0-9_-]/gu, '-')
  const displayTitle = trimmedLabel.length > 0
    ? trimmedLabel
    : route.photonProjectName.length > 0
      ? route.photonProjectName
      : 'Unnamed route'

  useEffect(() => {
    if (!routeDirty) {
      setLabel(route.label)
      setCwd(route.workspaceCwd)
      setProjectName(route.photonProjectName)
    }
  }, [routeDirty, route.label, route.workspaceCwd, route.photonProjectName])

  useEffect(() => {
    if (!phoneDirty) setPhone(route.phoneNumber ?? '')
  }, [phoneDirty, route.phoneNumber])

  const saveRoute = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!projectValid || !cwdValid) return
    void controller.upsertRoute({
      id: route.id,
      label: trimmedLabel,
      workspaceCwd: trimmedCwd,
      photonProjectName: trimmedProject,
      expectedRevision: state.revision,
    }).then((result) => {
      if (result?.ok === true) setRouteDirty(false)
    })
  }

  const savePhone = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!phoneValid) return
    void controller.saveRoutePhone(route.id, normalizedPhone, state.revision).then((result) => {
      if (result?.ok === true) setPhoneDirty(false)
    })
  }

  const removeRoute = (): void => {
    if (!window.confirm('Remove this route? Local routing for this line will be cleared. Photon projects and users will be preserved.')) {
      return
    }
    void controller.removeRoute(route.id, state.revision)
  }

  return (
    <article className="dsh-imessage-card">
      <CardTitle title={displayTitle} status={runtimeLabel(route.runtime)} />
      <form className="dsh-imessage-form" onSubmit={saveRoute}>
        <label htmlFor={`dsh-imessage-label-${fieldId}`}>Label</label>
        <input
          id={`dsh-imessage-label-${fieldId}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="Personal line"
          value={label}
          disabled={pending !== undefined}
          onChange={(event) => {
            setLabel(event.currentTarget.value)
            setRouteDirty(true)
          }}
        />
        <p className="dsh-imessage-muted">Optional display name for this route.</p>
        <label htmlFor={`dsh-imessage-cwd-${fieldId}`}>Local project directory</label>
        <input
          id={`dsh-imessage-cwd-${fieldId}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={workspacePathPlaceholder()}
          value={cwd}
          aria-invalid={cwd.length > 0 && !cwdValid}
          disabled={pending !== undefined}
          onChange={(event) => {
            setCwd(event.currentTarget.value)
            setRouteDirty(true)
          }}
        />
        {cwd.length > 0 && !cwdValid ? (
          <p className="dsh-imessage-error">Use an absolute directory path such as C:/project or /project, or leave it blank.</p>
        ) : (
          <p className="dsh-imessage-muted">Leave blank to use the directory where <code>dsh web</code> was started.</p>
        )}
        <label htmlFor={`dsh-imessage-photon-project-${fieldId}`}>Photon project name</label>
        <input
          id={`dsh-imessage-photon-project-${fieldId}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="dsh"
          value={projectName}
          aria-invalid={projectName.length > 0 && !projectValid}
          disabled={pending !== undefined}
          onChange={(event) => {
            setProjectName(event.currentTarget.value)
            setRouteDirty(true)
          }}
        />
        {projectName.length > 0 && !projectValid ? (
          <p className="dsh-imessage-error">
            Start with a letter or digit; only letters, digits, “.”, “_”, and “-” are allowed.
          </p>
        ) : (
          <p className="dsh-imessage-muted">
            Defaults to <code>dsh</code>. Changing this while authorized switches or creates that Photon project.
          </p>
        )}
        <div className="dsh-imessage-actions">
          <button
            type="submit"
            className="dsh-imessage-button dsh-imessage-primary"
            disabled={!routeDirty || !projectValid || !cwdValid || !canMutate}
          >
            {pending === 'upsert-route' ? 'Saving…' : 'Save route'}
          </button>
          <button
            type="button"
            className="dsh-imessage-button dsh-imessage-danger"
            disabled={!canRemove || !canMutate}
            onClick={removeRoute}
          >
            {pending === 'remove-route' ? 'Removing…' : 'Remove route'}
          </button>
        </div>
      </form>

      <form className="dsh-imessage-form" onSubmit={savePhone}>
        <label htmlFor={`dsh-imessage-phone-${fieldId}`}>Number you will text from</label>
        <input
          id={`dsh-imessage-phone-${fieldId}`}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+14155552671"
          value={phone}
          aria-invalid={phone.length > 0 && !phoneValid}
          disabled={pending !== undefined}
          onChange={(event) => {
            setPhone(event.currentTarget.value)
            setPhoneDirty(true)
          }}
        />
        {phone.length > 0 && !phoneValid ? (
          <p className="dsh-imessage-error">Use “+” followed by 2–15 digits; the first digit cannot be zero.</p>
        ) : null}
        {!authorized ? (
          <p className="dsh-imessage-muted">Authorize Photon before saving a number.</p>
        ) : !projectReady ? (
          <p className="dsh-imessage-muted">
            The <code>{route.photonProjectName}</code> project is still being prepared.
          </p>
        ) : null}
        {state.provisioning.phase === 'failed' ? <ErrorNotice error={state.provisioning.error} /> : null}
        <div className="dsh-imessage-actions">
          <button
            type="submit"
            className="dsh-imessage-button dsh-imessage-primary"
            disabled={!phoneValid || !authorized || !projectReady || !canMutate}
          >
            {pending === 'save-route-phone' ? 'Provisioning…' : 'Save number'}
          </button>
        </div>
      </form>

      {assigned === undefined ? (
        <p className="dsh-imessage-body">Your hosted iMessage number appears here after the sender is saved.</p>
      ) : (
        <>
          <div className="dsh-imessage-line">
            <div>
              <span className="dsh-imessage-label">Hosted iMessage number</span>
              <strong>{assigned}</strong>
            </div>
            <div className="dsh-imessage-actions">
              <button
                type="button"
                className="dsh-imessage-button"
                onClick={() => {
                  void copyText(assigned).then((ok) => {
                    setCopied(ok)
                    window.setTimeout(() => { setCopied(false) }, 2_000)
                  })
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a className="dsh-imessage-button dsh-imessage-primary" href={`sms:${assigned}`}>
                Text this number
              </a>
            </div>
          </div>
          <dl className="dsh-imessage-health">
            <div><dt>Listener</dt><dd>{runtimeLabel(route.runtime)}</dd></div>
            <div><dt>Workspace</dt><dd>{route.workspaceCwd}</dd></div>
            <div><dt>Photon project</dt><dd>{route.photonProjectName}</dd></div>
            <div><dt>Active session</dt><dd>{route.activeSessionId ?? 'A new session will be created'}</dd></div>
          </dl>
          {route.runtime.phase === 'failed' ? <ErrorNotice error={route.runtime.error} /> : null}
          {route.runtime.phase === 'retrying' ? (
            <p className="dsh-imessage-muted">
              Reconnect attempt {route.runtime.attempt} is scheduled for {formatTime(route.runtime.retryAt)}.
            </p>
          ) : null}
          <div className="dsh-imessage-actions">
            {route.runtime.phase === 'failed' || route.runtime.phase === 'stopped' ? (
              <button
                type="button"
                className="dsh-imessage-button"
                disabled={pending !== undefined}
                onClick={() => { void controller.retryRouteRuntime(route.id) }}
              >
                {pending === 'retry-route-runtime' ? 'Starting…' : 'Retry listener'}
              </button>
            ) : null}
          </div>
          <CommandReference />
        </>
      )}
    </article>
  )
}

function CardTitle({ number, title, status }: { number?: string; title: string; status: string }): ReactNode {
  return (
    <div className="dsh-imessage-card-title">
      <div>
        {number === undefined ? null : <span>{number}</span>}
        <h2>{title}</h2>
      </div>
      <small>{status}</small>
    </div>
  )
}

function CommandReference(): ReactNode {
  const commands = [
    ['/help', 'Show command help'],
    ['/new', 'Start a new DSH session'],
    ['/sessions [page]', 'List same-workspace root sessions'],
    ['/switch <index|session-id>', 'Change the active session'],
    ['/status', 'Show listener and session status'],
    ['/stop or /cancel', 'Stop the active turn'],
    ['/approve <request-id>', 'Approve a correlated request once'],
    ['/deny <request-id>', 'Deny a correlated request'],
    ['/answer <request-id> <answer>', 'Answer a correlated question'],
    ['//text', 'Send a normal prompt beginning with /'],
  ] as const
  return (
    <details className="dsh-imessage-commands">
      <summary>Command reference</summary>
      <dl>
        {commands.map(([command, description]) => (
          <div key={command}><dt><code>{command}</code></dt><dd>{description}</dd></div>
        ))}
      </dl>
      <p>Session switching and creation are refused during a turn or human interaction; send <code>/stop</code> first.</p>
    </details>
  )
}

function Expiry({ expiresAt }: { expiresAt: number }): ReactNode {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [])
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  return <span className="dsh-imessage-muted">Expires in {formatDuration(seconds)}</span>
}

function ErrorNotice({ error, onRetry }: { error: PublicPluginError; onRetry?: () => void }): ReactNode {
  return (
    <div className="dsh-imessage-error-box" role="alert">
      <strong>{error.message}</strong>
      {error.details === undefined || error.details.length === 0 ? null : (
        <ul>{error.details.map(detail => <li key={detail}><code>{detail}</code></li>)}</ul>
      )}
      {onRetry === undefined ? null : (
        <button type="button" className="dsh-imessage-button" onClick={onRetry}>Retry</button>
      )}
    </div>
  )
}

function authorizationLabel(state: ImessagePluginState): string {
  switch (state.authorization.phase) {
    case 'authorized': return state.provisioning.phase === 'ready' ? 'Authorized' : provisioningLabel(state)
    case 'pending': return 'Waiting for device login'
    case 'reauthorization-required': return 'Reauthorization required'
    case 'failed': return 'Authorization failed'
    case 'disconnected': return 'Not authorized'
  }
}

function provisioningLabel(state: ImessagePluginState): string {
  switch (state.provisioning.phase) {
    case 'project': return 'Preparing Photon project'
    case 'user': return 'Preparing hosted line'
    case 'failed': return 'Provisioning failed'
    case 'ready': return 'Authorized'
    case 'idle': return 'Authorized'
  }
}

function runtimeLabel(runtime: RuntimeView): string {
  switch (runtime.phase) {
    case 'listening': return 'Listening'
    case 'starting': return 'Starting'
    case 'retrying': return `Reconnecting (${runtime.attempt})`
    case 'failed': return 'Listener failed'
    case 'stopped': return 'Stopped'
  }
}

function isStrictE164(value: string): boolean {
  return /^\+[1-9]\d{1,14}$/u.test(value)
}

function isPhotonProjectName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
}

function workspacePathPlaceholder(): string {
  const platform = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    ?? navigator.platform
    ?? ''
  )
  return /win/i.test(platform) ? 'C:\\path\\to\\project' : '/absolute/path/to/project'
}

function openAuthorizationWindow(): Window | null {
  const popup = window.open(
    'about:blank',
    'dsh-photon-device-authorization',
    'popup,width=720,height=760,resizable=yes,scrollbars=yes',
  )
  if (popup !== null) {
    try {
      popup.document.title = 'Photon authorization'
      popup.document.body.textContent = 'Waiting for a Photon device code…'
    } catch {
      // A reused named window can still be cross-origin until about:blank commits.
    }
  }
  return popup
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

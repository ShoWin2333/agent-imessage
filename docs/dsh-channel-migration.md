# Native DSH channel plugin migration

This source supports DSH 0.2.1-rc.2 and 0.2.1-rc.5 / Cordis 4.0.5, plus DSH 0.2.2-rc.1 / Cordis 4.1.0. The published 1.1.0-dsh.11 package predates the 0.2.2 compatibility changes. The former `dsh-plugin` product line is now the default `main` branch; the independent macOS App history is preserved in `archive/standalone-macos-main-20261104`. Update raw/CDN index URLs to use `main`, since GitHub branch redirects do not cover every external CDN.

## Ownership

DSH owns sessions, Agents, model selection, tools, sandbox/approval policy, inbox admission, execution and cancellation. The plugin owns transport connections, account/owner/destination filters, channel admission receipts and outbound delivery. Three adapters are retained: Photon-hosted iMessage, Telegram and Weixin iLink. No standalone gateway, Cursor/Codex execution bridge, process installer or separate model credential system is included.

Credentials are references into the existing native provider. New bindings are disabled. Model selection must exist in the host catalog; permission presets must already exist. The settings sidebar exposes Agent/project groups and independent channel edit/save/cancel/start/stop operations. Concurrent writes use the native Settings revision.

## Native contracts

- `agents.create` creates a binding session; a saved session ID resumes with `agents.resume`. New/resumed shared Agents are created through an application-root Context with the binding’s service isolation labels, so full transport-plugin unload cannot tear down desktop work. Cordis 4.0.5 exports this root Context API as experimental. The exact binding prefix and workspace are verified before resume. Only initialization is linked to binding cancellation: `open()` forwards a temporary signal to native create/resume, then detaches it when open settles. Stopping a binding can therefore abort suspended initialization without stopping a successfully shared Agent. Already-live Agents remain under their existing owner; the SDK has no ownership-transfer API, so this does not retrofit the lifetime of an Agent created by an older plugin build.
- Idle input uses `agent.followup`. Further input in a channel-owned active turn uses `agent.steer`, consumed at a native step boundary. Input arriving during a host-owned turn is queued as its own followup, without taking over reply ownership. Native driver closing/abort races determine the admitted turn; the plugin never compensates by submitting twice.
- `agent/inbox/claimed` binds exact input IDs to turns. The first claimant is the fixed reply/interaction owner; same-turn channel refinements receive durable suppressed receipts. `session/event` supplies assistant messages and terminal boundaries. `turn/end` is followed by an explicit persistence flush before delivery.
- Admission flush completes before the external cursor advances. Native inbox splices reconstruct claim/cancel state during restart recovery. Interrupted or uncertain work is never automatically resubmitted.
- Channel cancellation removes only this binding’s queued inputs and cancels only its own active turn, irrespective of which surface created the Agent. Desktop inbox entries are retained; stopping a binding leaves an Agent with active or queued desktop work attached to its native host context.
- Cancellation uses the native Agent API. For a session bound to Telegram, Weixin, or iMessage, one DSH tool approval can be answered in the desktop or in its bound channel. The first valid answer wins. Channel reply expiry does not expire the desktop request. Questions fall back from the host only on native no-provider outcomes. Channel interactions use exact Agent/input/turn identity, expiring one-use tokens and fail-closed cancellation/disconnection/restart behavior.
- Shared approval coordination uses the public scoped `ctx.waterfall` to deliver a copy with a coordinator-owned cancellation signal to the native desktop answerer. A weak request marker skips coordination for that copy. The first valid decision settles one native approval request and aborts both presentation lifetimes; the caller signal and tool execution remain untouched. This also withdraws the native desktop card on unload, policy change, turn completion and Agent disposal, including requests with no caller signal. No DSH files, private listener lists, borrowed requests or original AbortSignals are modified. **Composition limit:** Cordis 4.0.5 does not let `next()` replace request arguments, so this deliberately re-enters outer `approval/request` middleware and uses a fresh dispatch-time listener snapshot. Ownership/delegation checks are safe to repeat; arbitrary middleware with non-idempotent side effects or dynamic answerer replacement may behave differently from the original continuation. The installed desktop composition was inspected: its other approval responder is the native Remote/UI bridge; ACP is installed in a separate profile, and Auto review runs on `tools/pre-execute`, not this answerer chain. The tests characterize outer re-entry explicitly and verify the tool review and guards run once. Channel timeout applies only to channel replies, not the desktop wait. Native UI withdrawal is tested against the pinned DSH 0.2.1-rc.2 browser consumer with in-memory transport/registry adapters; it is not a rendered or serialized transport end-to-end test. Custom answerers must honor the supplied signal to withdraw their own prompts.
- Delivery is pending, sending, sent or uncertain. A send interrupted by a crash is quarantined rather than retried. No fixed progress text is sent; adapters retain typing where supported.

## Session and project continuity

A binding key includes channel identity, canonical workspace, permissions and model selection. Changing these fields selects a distinct scope; all old session mappings and histories are retained. Restoring an identical previous configuration reselects its existing saved session ID, if present. Resuming that session uses the last durable native request model. The plugin does not import, copy or merge historical conversation bodies from independent applications. Workspace attachment verifies the session's canonical cwd and exact plugin ownership; it never moves unrelated sessions or recreates IDs.

Credential references are excluded from the current key. On the first upgrade from a credential-scoped key, keep the original `credentialRef`: migration records only the exact session IDs in that configured legacy journal, retaining IDs and receipts for resume, recovery and project grouping. This grant persists across restarts and subsequent credential-reference rotations. If an older build already copied the row and its reference was changed before this migration, the original legacy reference must be verified for recovery; the plugin refuses to guess session ownership or create a replacement history.

## Removed channel configurations

This unpublished working tree removes Discord and Feishu adapters and their SDK dependencies. It does not migrate, filter, stop or delete existing user bindings automatically. Unsupported kinds are rejected by both native and runtime configuration validation before credentials or storage are opened on startup. An invalid live configuration update preserves the last accepted consumers and reports `config-invalid`. The settings panel shows a read-only error rather than deleting unsupported bindings or changing their Agent membership.

Do not switch an existing profile containing either retired kind to this build without a separately reviewed configuration change. Inventory the affected enabled consumers and stop them in the currently installed version first. Any later configuration-only removal must remove the exact retired bindings and their ids from `agents[].bindingIds` together, while retaining empty Agent groups and every remaining binding field. This source change does not perform that operation.

Existing storage-domain journals, dedupe/cursor metadata, session files, Host credential references/values, Workspace metadata and project files remain untouched. Surviving bindings retain their identity keys. A rejected retired binding does not grant another channel access to its old session or replay its messages. Removing configuration must not be implemented by clearing the storage domain or deleting session files. The currently published package and market version are unchanged by this local work.

## Controlled cutover

Inventory account/owner/destination identity, existing consumers and credential references first. Stop and verify the corresponding old consumer before enabling its new binding. Transfer only validated dedupe IDs and the provider cursor where necessary, through native storage APIs; Telegram uses a numeric cursor and Weixin preserves its opaque cursor exactly. Keep a local backup and a reversible deployment path. Do not duplicate consumers or replay missed messages to test a deployment.

### Renamed npm bundle

`@showin2333/dsh-plugin-channels` is the canonical package name. When moving from `@showin2333/dsh-channels`, replace only the dependency, selected bundle and module references. Keep the `dsh-channels` / `dsh-channels-projects` row IDs, every binding field, and the existing storage and session mappings. Stop the old consumers before enabling the replacement; never load both package names together. No credential value needs to be copied.

Earlier local-package migration:

`@showin2333/dsh-channels` replaces the former local `@showin2333/agent-imessage` package. This is a package/registration migration: the storage domain, binding identities and native session IDs remain unchanged. Preserve every binding field, including model and permission selection and credential references; no secret needs to be copied.

Back up the profile and stop the old consumers before switching the selected bundle dependency. Move the old `agent-imessage-dsh-channels` settings to `dsh-channels`, and replace the old `agent-imessage-dsh-projects` registration with `dsh-channels-projects` pointing at `@showin2333/dsh-plugin-channels/project-groups`. Remove old-package overrides and any obsolete wrapper reference; installing the new bundle alongside the old one is not a migration. Verify one consumer per channel, unchanged saved session mappings and the Settings page before accepting the cutover. Keep the backup until this verification succeeds.

## Current limits

Task ingress remains text. Channel-owned Agent scopes now register `channel_send_media` for approved workspace-local image/file/audio uploads to their fixed recipient. Media tool calls cannot select another binding or recipient. Per-call media receipts persist sending/sent/uncertain metadata only, never file bytes; recovery quarantines interrupted media sends and does not re-upload them. General native scheduled-task delivery is not integrated. Unsupported inbound attachments request a text task rather than executing a partial prompt. Scheduler fixed-session/catch-up semantics do not automatically reproduce an independent application's isolated scheduled tasks. No scheduler migration or automatic replacement is implied.

The suite uses synthetic channels and denies unmocked network access. Run `npm run check` for both type checks, offline tests, browser artifact smoke rendering, build and package inspection. No real messages, paid model calls, production credentials or private rollout evidence are part of the test suite.

## SDK compatibility checks

Both tested 0.2.1 RCs consume an entry-point-owned model selection reference, while 0.2.2 keeps the selection on the Agent. The plugin supplies the complete provider/model/optional effort to native create and resume, and calls the public installer through one compatible function signature. The older installer uses the state argument; the newer installer ignores it. No arity detection, SDK patching or version-specific execution path is needed. Saved request models remain the resume fallback; the newer Agent retains precedence for its durable model selection.

The repository lockfile remains the 0.2.1 baseline. The extra CI matrix prepares separate rc.5 / Node 22 and 0.2.2 / Node 26 dependency environments and runs the same complete check. For local reproduction, choose a new directory outside the checkout:

```sh
node scripts/prepare-dsh-sdk-check.mjs /tmp/channels-dsh-sdk-check 0.2.2-rc.1
pnpm --dir /tmp/channels-dsh-sdk-check install --no-frozen-lockfile --ignore-scripts
npm --prefix /tmp/channels-dsh-sdk-check run check
```

The preparation script only copies and rewrites test dependency declarations; it does not install anything or touch DSH profiles. The shared tests supply the new approval projection and native tool executor, and exercise both the legacy request hooks and modern Agent-owned model state. Host application installation, live channel activation and npm publication are separate from these checks.

Use `0.2.1-rc.5` as the preparation script’s final argument for that SDK. The persistence regression uses the real JSONL backend, real Session/AgentLoop instances, fresh Contexts across each close/reopen, and an offline model adapter. It verifies an actual request after changing provider/model and effort, then clears effort and reopens again; modern SDKs also cover a pending durable choice with no intervening model request.

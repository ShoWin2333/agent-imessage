# Native DSH channel plugin migration

This branch targets DSH 0.2.1-rc.2 and Cordis 4.0.5. It is the `dsh-plugin` product line; the independent macOS App remains on `main`.

## Ownership

DSH owns sessions, Agents, model selection, tools, sandbox/approval policy, inbox admission, execution and cancellation. The plugin owns transport connections, account/owner/destination filters, channel admission receipts and outbound delivery. Four adapters are retained: Photon-hosted iMessage, Telegram, Weixin iLink and Discord. No standalone gateway, Cursor/Codex execution bridge, process installer or separate model credential system is included.

Credentials are references into the existing native provider. New bindings are disabled. Model selection must exist in the host catalog; permission presets must already exist. The settings sidebar exposes Agent/project groups and independent channel edit/save/cancel/start/stop operations. Concurrent writes use the native Settings revision.

## Native contracts

- `agents.create` creates a channel-owned session; a saved session ID resumes with `agents.resume`. The exact binding prefix and workspace are verified before resume. Other consumers' live Agents are never adopted.
- Idle input uses `agent.followup`. Further input in a channel-owned active turn uses `agent.steer`, consumed at a native step boundary. Input arriving during a host-owned turn is queued as its own followup, without taking over host approval or reply ownership. Native driver closing/abort races determine the admitted turn; the plugin never compensates by submitting twice.
- `agent/inbox/claimed` binds exact input IDs to turns. The first claimant is the fixed reply/interaction owner; same-turn channel refinements receive durable suppressed receipts. `session/event` supplies assistant messages and terminal boundaries. `turn/end` is followed by an explicit persistence flush before delivery.
- Admission flush completes before the external cursor advances. Native inbox splices reconstruct claim/cancel state during restart recovery. Interrupted or uncertain work is never automatically resubmitted.
- Cancellation uses the native Agent API. Host approval/question handlers run first. Channel fallback is permitted only for native unavailable/no-provider outcomes, with exact Agent/input/turn identity, expiring one-use tokens and fail-closed cancellation/disconnection/restart behavior.
- Delivery is pending, sending, sent or uncertain. A send interrupted by a crash is quarantined rather than retried. No fixed progress text is sent; adapters retain typing where supported.

## Session and project continuity

A binding key includes channel identity, canonical workspace, permissions and model selection. Changing these fields selects a distinct scope; all old session mappings and histories are retained. Restoring an identical previous configuration reselects its existing saved session ID, if present. Resuming that session uses the last durable native request model. The plugin does not import, copy or merge historical conversation bodies from independent applications. Workspace attachment verifies the session's canonical cwd and exact plugin ownership; it never moves unrelated sessions or recreates IDs.

Credential references are excluded from the current key. On the first upgrade from a credential-scoped key, keep the original `credentialRef`: migration records only the exact session IDs in that configured legacy journal, retaining IDs and receipts for resume, recovery and project grouping. This grant persists across restarts and subsequent credential-reference rotations. If an older build already copied the row and its reference was changed before this migration, the original legacy reference must be verified for recovery; the plugin refuses to guess session ownership or create a replacement history.

## Controlled cutover

Inventory account/owner/destination identity, existing consumers and credential references first. Stop and verify the corresponding old consumer before enabling its new binding. Transfer only validated dedupe IDs and the provider cursor where necessary, through native storage APIs; Telegram uses a numeric cursor and Weixin preserves its opaque cursor exactly. Keep a local backup and a reversible deployment path. Do not duplicate consumers or replay missed messages to test a deployment.

## Current limits

Task ingress is text. Adapters retain attachment sending methods, but model-callable media tools and general native scheduled-task delivery are not integrated. Unsupported inbound attachments request a text task rather than executing a partial prompt. Scheduler fixed-session/catch-up semantics do not automatically reproduce an independent application's isolated scheduled tasks. No scheduler migration or automatic replacement is implied.

The suite uses synthetic channels and denies unmocked network access. Run `npm run check` for both type checks, offline tests, browser artifact smoke rendering, build and package inspection. No real messages, paid model calls, production credentials or private rollout evidence are part of the test suite.

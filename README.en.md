# Agent iMessage

This repository maintains two parallel product lines:

| Product | Where it runs | Location |
| --- | --- | --- |
| **macOS App / Gateway** | Native macOS app with Cursor / Codex / headless DSH backends | Repository root (this README) |
| **DSH iMessage plugin** | Original DSH Web plugin on **Windows / Linux / macOS** | [`apps/dsh-imessage`](./apps/dsh-imessage) |

Use the DSH plugin on Windows. The two lines share the Photon iMessage idea but keep separate configuration, UI, and process models.

A standalone local Agent App / Gateway for iMessage. One native macOS SwiftUI app manages multiple projects backed by **Cursor SDK**, **Codex App Server**, or **headless DSH**. No desktop editor or DSH Web process is required.

```text
iMessage ↔ Photon / Spectrum ↔ Gateway ↔ Backend
                               │        ├─ Cursor official SDK (local sandbox)
                               │        ├─ Codex App Server (stdio)
                               │        └─ DSH ACP (headless process)
                               └─ routing, sessions, approvals, questions, media,
                                  configuration, secrets, status and native-app API
```

## Run

Node.js 22.19+ (22.x) or 24+ is required.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run build
npm start
# Optional global installation from this checkout
npm install -g . --ignore-scripts
agent-imessage start
```

Open the native macOS app (`./script/build_and_run.sh` for development); port 8787 serves its local API only. Add projects with a backend, absolute workspace path, model/effort settings, Photon project, authorized sender and assigned recipient. Supply a Photon project secret in the UI or an environment variable. You can authorize Photon and provision a shared number from the UI.

Each route requires a unique ID and Photon project; sender/recipient pairs must not overlap. Stop old consumers before connecting the new Gateway to the same project. Photon shared lines require a **phone-number iMessage identity**, not an email identity.

- **Cursor:** the pinned official `@cursor/sdk` and a Cursor API key (UI or `CURSOR_API_KEY`). No Cursor CLI / ACP. Local sandbox enabled by default, with project rules (AGENTS.md and .cursor settings) loaded. The UI also offers auto-review or explicit unrestricted execution, and optional user settings. SDK sandbox refusals are not converted into automatic permission grants; the SDK does not expose a general native approval callback to this app.
- **Codex:** locally installed `codex`, authenticated with `codex login`. Uses App Server with workspace-write and untrusted approval policy.
- **DSH:** a complete DSH CLI installation and model credentials; tested with `0.1.5-rc.1`. Runs `dsh --profile acp` with workspace-write. DSH model IDs are the values advertised by ACP and may include a provider prefix.

Only the chosen backend must be installed. Set `codexBinary` or `dshBinary` to an absolute executable path when needed.

## Background operation

```sh
agent-imessage service install /absolute/path/config.json
agent-imessage service remove
```

The built-in installer currently supports macOS launchd. The service is `app.agent-imessage.gateway`, starts at login and restarts on failure. It uses absolute Node/application paths; reinstall after moving the installation. Logs are stored beside the config under `logs/gateway.log`. Other platforms can supervise `agent-imessage start` themselves.

## Configuration and migration

Default config: `~/.config/agent-imessage/config.json`. Secrets are stored separately in `config.json.secrets.json`, Photon OAuth in `config.json.photon.json`; files are private (`0600`) and their parent directory must be `0700`. The native app never receives saved secrets. launchd does not inherit interactive shell variables: prefer saved secrets or explicitly configured service environment variables.

A version-1 config contains `port`, an absolute `stateDir`, optional backend binary paths, and `routes`. Each route has `id`, `backend`, `cwd`, `projectId`, `projectSecretEnv`, `senderPhoneNumber`, `assignedPhoneNumber`, and optional `label`, `enabled`, `model`, `effort`, `speed`, `cursorMode` and `cursorApiKeyEnv`. See the full [Chinese guide](README.md) for an example.

Legacy bridge JSON can be passed directly to `start`; omitted backends remain Codex, existing Codex state is retained, and obsolete `cursorBinary` is ignored. Old Cursor ACP sessions are not SDK sessions and are kept isolated.

```sh
agent-imessage import ~/.config/cursor-imessage-app/config.json ~/.config/agent-imessage/config.json
agent-imessage import /private/dsh-settings.json /private/new/config.json /private/dsh-photon-credential.json
```

Import preserves source files, refuses an existing destination, and migrates all routes or fails validation. The standard Cursor prototype directory also supports dedupe and verified local SDK session migration. DSH flat/multi-route settings and v1/v2 Photon credential exports are supported; old DSH plugin active-session mappings are not automatically migrated. DSH's own historical sessions remain intact.

`apps/cursor-imessage` is now only a launcher. The optional editor extension opens the standalone UI and no longer owns configuration or process lifetime. The DSH plugin continues as a parallel product in [`apps/dsh-imessage`](./apps/dsh-imessage); the separate Codex distribution is retired.

## Commands and media

`/help`, `/status`, `/new`, `/sessions`, `/switch ID`, `/stop` (`/cancel`), `/approve ID`, `/deny ID`, `/answer ID {"question-id":"answer"}`. Use `//` to escape a leading slash. Busy prompts are rejected rather than invisibly queued. Session switching is restricted to the route's last 100 recorded sessions.

All backends use shared `send_imessage_file`, `send_imessage_voice`, and `ask_imessage_user` tools. Outgoing files/images and native voice are limited to regular in-workspace files up to 20 MiB, with traversal/symlink and turn-ownership checks. Incoming media and speech transcription remain unsupported; the existing inbound path accepts text only.

## Development

`src/app` owns the application, configuration, migration, Web API and service installer. `src/gateway` owns routing, sessions and shared tools. `src/backends/types.ts` defines the typed execution interface. Adapters have no Photon delivery implementation. `src/spectrum-runtime.ts` and the Photon/media modules are the single transport and security implementations.

To add an agent, implement `Backend` and register its factory/config/UI option. No new iMessage or Photon layer is needed.

```sh
npm run typecheck
npm test
npm run build
npm run audit:prod
npm run test:package
npm pack --dry-run --ignore-scripts
CURSOR_API_KEY_FILE=/private/cursor.api-key npm run test:cursor:live
npm run test:codex:live
```

Live SDK/App Server tests use a temporary workspace and a fake recipient. Full acceptance additionally requires sending from the authorized phone through Photon and checking the reply. See [SECURITY.md](SECURITY.md) for the trust boundary.

Each project card supports **Save and apply this project**, restarting only that route while preserving other routes and unsaved form drafts. Photon projects and backend models can be selected from live catalogs. Approval choices reflect each backend's capabilities; Cursor native approvals cannot be answered through `/approve`. Project settings may also load SDK-supported hooks and MCP configuration.

## Weixin iLink and channel adapters

The local UI now supports personal Weixin bot QR binding through iLink. Bind a bot,
add a Weixin entry to a project, and save. Disable iMessage for Weixin-only projects;
Photon is not required for those projects. Each `channels` entry has its own backend
instance, session, dedupe state and approvals. Only the bound Weixin owner is allowed.
Text commands, approvals, questions and workspace file delivery are supported;
inbound attachments and native voice sending are not yet supported. Existing
flat iMessage configurations remain supported. Preserve the legacy identity fields
and the `imessage` channel ID when migrating by hand to retain its existing session.

Credentials stay in the private local secrets file, and QR images are generated
locally. Long polling needs no public callback. See [protocol attribution](THIRD_PARTY_NOTICES.md).

For the local macOS wrapper, run `./script/build_and_run.sh --verify` or the Codex
Run action. The wrapper restores window placement, supports editing shortcuts and
reconnect controls, and leaves pre-existing background services running on quit.
It supports fixed custom ports and creates a bundled service plist if no installed
LaunchAgent exists. It still depends on this checkout and the local Node runtime.


Build a self-contained macOS app with `npm run package:macos -- '/tmp/Agent iMessage.app'`.
Validate relocation and isolated startup with `npm run test:macos:package -- '/tmp/Agent iMessage.app'`.
The release bundle includes checksum-pinned official Node 22.23.2, locked production
dependencies, Gateway and web assets. Building requires network access, npm and Xcode
Command Line Tools; running requires neither Node nor the checkout. Builds target the
host architecture (arm64 or x64). Existing output paths are never overwritten.

Quit the old app and copy the new bundle into Applications. Runtime service paths
are generated from the installed location. Existing config/secrets/avatars in
`~/.config/agent-imessage/` and the configured state directory are preserved outside
the bundle. No builder credentials or LaunchAgent are included. Desktop logs and the
generated plist live in `~/Library/Application Support/Agent iMessage/Desktop/`.
`AGENT_GATEWAY_CONFIG` can override the config at launch; the configured port must be
fixed. External Agent tools still need installation/login; an installed Codex desktop app
is discovered automatically through Launch Services. Configure absolute
`codexBinary`/`dshBinary` paths for nonstandard installs. Stop any pre-existing
background service before switching to the bundled service. Development still uses
the lightweight Run script. Release bundles are locally ad-hoc signed; public
distribution still requires Developer ID signing and notarization. Node and dependency
licenses are included. Update pinned Node hashes in `scripts/macos/package.mjs` and
rerun packaging checks when maintaining the bundled runtime.


### Resident menu bar and service ownership

The menu bar reports connectivity, workspace count, activity and failures, with
Open Management, Reconnect and Quit actions. Closing the window hides the Dock
entry while keeping the app/service running; reopening through the menu bar
restores the window and Dock. Minimize retains standard macOS behavior. Reconnect
does not reload an already loaded management page or discard form drafts.

App-started launchd jobs receive unique labels and a persisted random ownership
marker before bootstrap. Relaunch adopts an orphan only when its config, loaded
job source and marker match. Quit revalidates ownership before stopping the job.
Legacy jobs without receipts, manual LaunchAgents and directly started Gateway
processes stay external. A failed stop cancels Quit and retains the recovery
receipt. Closing a window does not enable login startup.

`npm run test:macos:service` checks actual isolated launchd ownership/replacement
behavior. `npm run test:macos:native -- '/tmp/Gateway Standalone Test.app'` uses the
dedicated test identity and empty config to cover menu/window behavior, SIGKILL
recovery, relocation, Quit during startup and external-process preservation.
Native tests require a logged-in macOS desktop session.


The browser UI and editor browser launcher have been removed. `npm start` runs the loopback API only; use the macOS app (`./script/build_and_run.sh` for development). Tasks persist independently of the 200-event diagnostic buffer, with separate execution and delivery states. Desktop controls stop tasks, resolve pending requests, and resend stored text results without repeating execution. Interrupted tasks never replay automatically after restart.

Canonical workspaces admit one task at a time within the Gateway. Labels, avatars and schedules apply without restart; model parameters apply on the next task; changing workspace, permissions, bindings or credentials requires affected tasks to be stopped first. Scheduled tasks default to independent sessions, offer common time selectors, previews and a manual trial, and record skipped slots without catch-up.

### Telegram channel

All three transports use the same workflow: **消息渠道** manages accounts and credentials; **Agent → 项目配置 → 消息入口** manages bindings. Add and verify Telegram bots, scan WeChat accounts, or authorize Photon and prepare iMessage numbers on the channels page. This page shows the owning Agent and links to its settings but does not assign Agents.

In Agent settings choose **绑定 iMessage / 微信 / Telegram**, select an existing account, and save. Occupied accounts show their owner and are disabled. Unbind and save in the old Agent before reassigning; credentials remain available. Adjust schedules before detaching a referenced channel. Disabled Agents still reserve their accounts. For Telegram, Bot ID and username are discovered from the Bot Token; send `/start` from the configured owner after binding.

The adapter uses [Bot API long polling](https://core.telegram.org/bots/api#getupdates), requiring outbound access to `api.telegram.org` but no public port. Each bot belongs to exactly one channel, including disabled projects. Stop other pollers and remove any existing webhook before using it here.

Only the configured owner's private text messages execute tasks. Groups, other users, bots and edited messages are ignored; incoming attachments and captions are not executed. Replies, typing indicators, chunked text, file delivery, isolated sessions, approval commands and scheduled tasks use the existing gateway. Audio is delivered as a file; incoming media and native voice delivery are not supported yet. Start a conversation with the bot before scheduling messages.

Tokens are stored separately in `config.json.secrets.json` with mode `0600`, never in public status responses. Leave the token field blank to keep the saved credential. For manual configuration, add `{"id":"telegram","kind":"telegram","botId":"123456789","ownerUserId":"987654321"}` to a route's `channels`, and add `"telegram":{"123456789":"123456789:YOUR_BOT_TOKEN"}` to the secrets file, preserving other fields such as `photon`.

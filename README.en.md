# Agent iMessage

A standalone local Agent App / Gateway for iMessage. One local Web UI manages multiple projects backed by **Cursor SDK**, **Codex App Server**, or **headless DSH**. No desktop editor or DSH Web process is required.

```text
iMessage ↔ Photon / Spectrum ↔ Gateway ↔ Backend
                               │        ├─ Cursor official SDK (local sandbox)
                               │        ├─ Codex App Server (stdio)
                               │        └─ DSH ACP (headless process)
                               └─ routing, sessions, approvals, questions, media,
                                  configuration, secrets, status and Web UI
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

Open **http://127.0.0.1:8787**. Add projects with a backend, absolute workspace path, model/effort settings, Photon project, authorized sender and assigned recipient. Supply a Photon project secret in the UI or an environment variable. You can authorize Photon and provision a shared number from the UI.

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

Default config: `~/.config/agent-imessage/config.json`. Secrets are stored separately in `config.json.secrets.json`, Photon OAuth in `config.json.photon.json`; files are private (`0600`) and their parent directory must be `0700`. The browser never receives saved secrets. launchd does not inherit interactive shell variables: prefer saved secrets or explicitly configured service environment variables.

A version-1 config contains `port`, an absolute `stateDir`, optional backend binary paths, and `routes`. Each route has `id`, `backend`, `cwd`, `projectId`, `projectSecretEnv`, `senderPhoneNumber`, `assignedPhoneNumber`, and optional `label`, `enabled`, `model`, `effort`, `speed`, `cursorMode` and `cursorApiKeyEnv`. See the full [Chinese guide](README.md) for an example.

Legacy bridge JSON can be passed directly to `start`; omitted backends remain Codex, existing Codex state is retained, and obsolete `cursorBinary` is ignored. Old Cursor ACP sessions are not SDK sessions and are kept isolated.

```sh
agent-imessage import ~/.config/cursor-imessage-app/config.json ~/.config/agent-imessage/config.json
agent-imessage import /private/dsh-settings.json /private/new/config.json /private/dsh-photon-credential.json
```

Import preserves source files, refuses an existing destination, and migrates all routes or fails validation. The standard Cursor prototype directory also supports dedupe and verified local SDK session migration. DSH flat/multi-route settings and v1/v2 Photon credential exports are supported; old DSH plugin active-session mappings are not automatically migrated. DSH's own historical sessions remain intact.

`apps/cursor-imessage` is now only a launcher. The optional editor extension opens the standalone UI and no longer owns configuration or process lifetime. The old DSH plugin UI and separate Codex distribution are retired.

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

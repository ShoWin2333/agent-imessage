# Agent iMessage — Codex adapter (preview)

Use iMessage to work with a local Codex instance through the official App Server protocol. This package does **not** require DSH. The same repository also maintains the existing DSH adapter.

This is an independent community integration, not an OpenAI or Apple product. It uses Photon-hosted iMessage transport. It does not connect to Codex Cloud or promise control of existing desktop-app tasks.

## Requirements

- Node.js 22.19+ (22.x) or 24+.
- A locally installed Codex CLI, authenticated with `codex login`. The protocol was checked against `codex-cli 0.154.0-alpha.6.2`. Dynamic media tools use the experimental App Server API, so other versions need verification.
- A dedicated Photon project with iMessage enabled, a provisioned hosted number, and your sender number configured as a Spectrum user. Obtain these through Photon; this preview does not include a Photon signup/provisioning UI.
- The computer and bridge must stay running. Photon service availability and charges are separate from Codex.

## Install from this repository

This package has not been published to npm. From the repository root:

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run build:codex
npm pack ./packages/codex
npm install --global ./showin2333-agent-imessage-0.1.0.tgz
agent-imessage doctor
```

The source build installs DSH development dependencies; the resulting Codex tarball depends only on Spectrum and Zod, with no DSH peer dependencies. `doctor` checks the default `codex` on PATH and account availability without starting a model turn or connecting to Photon. `start` can use a custom `codexBinary` in its config.

## Codex CLI compatibility

Some standalone alpha CLI installs lack a sibling `codex-code-mode-host` executable. In that case text replies can work while tool calls fail. `doctor` checks the connection and account, not tool execution. Use a complete matching Codex distribution and set `codexBinary` to its executable. Do not disable the host: this version also needs it for dynamic tools. No global Codex configuration changes are needed.

## Configure and start

Copy `config.example.json` to a local file and replace the placeholders. `cwd` and `stateDir` must be absolute paths. Use a separate Photon project for each route; never run this bridge and DSH against the same Photon project simultaneously.

```json
{
  "codexBinary": "codex",
  "stateDir": "/Users/you/.local/state/agent-imessage",
  "routes": [{
    "id": "codex-main",
    "cwd": "/Users/you/projects/example",
    "projectId": "YOUR_PHOTON_PROJECT_ID",
    "projectSecretEnv": "AGENT_IMESSAGE_PHOTON_SECRET",
    "senderPhoneNumber": "+15551234567",
    "assignedPhoneNumber": "+15557654321"
  }]
}
```

Set the environment variable named by `projectSecretEnv` using your local secret manager or shell environment, then run:

```sh
agent-imessage start /absolute/path/to/config.json
```

Do not commit the configuration or project secret. Each route gets its own Codex App Server process, workspace, thread state and approval broker. Photon secret variables referenced by the configuration are removed from the Codex child process environment. The bridge creates its state directory with mode 0700; if it already exists, it must have those permissions. State files use mode 0600.

DSH and Codex can run side by side using different Photon projects. DSH routes remain configured in DSH's Settings → iMessage; Codex routes use this file. There is no shared settings UI in this preview.

## Commands

| Message | Action |
| --- | --- |
| Ordinary text | Start a task in this route's workspace, resuming its stored thread. |
| `/new` | Clear the active thread selection while idle; the next message starts a fresh thread. |
| `/status` | Show this route's thread, running state, and pending requests. |
| `/stop` or `/cancel` | Interrupt the current task and cancel pending approvals/questions. |
| `/approve ID` | Approve exactly one displayed command or file-change request. |
| `/deny ID` | Reject that request. |
| `/answer ID {"question-id":"answer"}` | Answer every question using the displayed question IDs. |
| `/help` | Show command help. |
| `//...` | Send a prompt that begins with `/`. |

A route accepts one task at a time. New prompts while busy receive a busy response and are not queued. Only final answers are returned; intermediate commentary and reasoning are not forwarded. The agent can call `send_imessage_file` or `send_imessage_voice` to deliver an existing file from its workspace when asked. Inbound attachments and audio are not supported.

## Boundaries and recovery

- Only the configured sender's inbound iMessage direct messages are accepted. Shared Photon lines rely on project isolation in addition to sender filtering.
- Thread and turn IDs bind all outputs, tools, approvals and answers to their initiating route. Work started elsewhere is not delivered to iMessage.
- Threads use `workspace-write` and `untrusted` approval policy. Existing Codex configuration and policy still apply; this is not a guarantee that every local command requires approval.
- Approvals expire after ten minutes. Session-wide grants, unsupported permission requests, secret questions, and requests too large to display completely are refused. File approvals require the associated diff.
- Loss of Photon connectivity interrupts the active turn and cancels pending approvals. Requests are not silently approved on timeout or failure. If Codex exits or a request times out, restart the bridge; it does not automatically restart potentially ambiguous work.
- Media is limited to regular files inside the canonical workspace and 20 MiB. Existing symlink escapes are rejected. The workspace must remain trusted: concurrent filesystem changes by other local processes are outside this preview's isolation guarantee.
- The bounded replay window remembers 1,024 message IDs before execution. A crash may leave a received message unfinished; resend it as a new message after checking the thread. This is not exactly-once processing or guaranteed delivery.
- A per-route lock prevents duplicate processes sharing the same state directory. After a hard crash, stop/verify the old process before removing only that route's `.lock` directory. Graceful Ctrl+C releases locks. Different state directories cannot detect each other's listeners.
- No secret values or raw Codex errors are logged by the bridge. Messages and requested attachments still travel through Photon and iMessage; ordinary tasks run through your configured Codex provider.

## Validation

From the repository root:

```sh
npm test
npm run build
npm run build:codex
npm run test:codex:pack
# Optional: starts a real Codex task using your local account, but no Photon messages.
npm run test:codex:live
```

A live Codex smoke test uses a temporary workspace and fake iMessage transport. Real phone delivery must be verified separately with a dedicated Photon route before treating this preview as production-ready.

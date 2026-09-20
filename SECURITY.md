# Security boundaries

Agent iMessage is a local, single-user Gateway. Its native-app API binds only to `127.0.0.1`, validates the exact Host and Origin, requires a per-process CSRF token for writes, sends no CORS permission, limits request bodies, and never returns stored secrets. It is not a multi-user remotely accessible control plane.

Configuration, Photon credentials and management tokens are private files (`0600`) in a private directory (`0700`). Atomic replacement avoids partial JSON. Invalid files fail closed rather than resetting the configuration. Environment variable names are public configuration; their values are not. Do not place configuration/secrets in an Agent-accessible project or commit them to source control.

Only configured sender/recipient DMs are accepted. Shared-line routing markers are accepted only inside the selected Photon project. Group, outgoing/echo and unsupported inbound-media messages are rejected. Provider message IDs are durably recorded before dispatch. Unknown-outcome tasks are not replayed automatically.

Route state binds the route ID, canonical workspace, Photon project, authorized sender, recipient and backend. Cursor SDK sessions cannot inherit old ACP sessions. Route locks prevent duplicate listeners in a state root; dead-PID locks can be reclaimed, while unknown or live owners fail closed. There must also be only one application consuming a Photon project across machines/state roots.

Approvals/questions belong to one active route and turn. Disconnect, stop, completion, timeout and shutdown cancel pending interaction. Only single-action approval is supported; oversized, undisplayable, secret-input, unknown and broad-root-grant requests fail closed. Late results and tool calls cannot send media after cancellation.

Files/images/voice are read through one shared validator: canonical workspace containment, no symlink escape, regular files only, size limit 20 MiB and cancellation checks. Native voice requires an audio type. Custom tools run in the host process, so they always perform these checks regardless of a backend's own sandbox.

Cursor executes through the official SDK in a worker with configured Photon environment variables removed; the SDK local sandbox is enabled by default and project settings are loaded. Local users can explicitly select unrestricted execution (no sandbox), auto-review, or additional user settings. Codex and DSH run in per-route processes with Photon credentials removed. Codex requests workspace-write and on-request/never approval and explicit user/auto_review reviewer selection; DSH pins the permission-mode environment to workspace-write. Runtime stderr and raw upstream failures are not sent over iMessage.

The backend's own OS sandbox and permission implementation remain part of the trust boundary. Gateway workspace configuration is not itself an OS sandbox. Locally installed DSH composition patches and backend executables are trusted. The Cursor SDK currently does not provide a generic native tool-approval callback; rejected sandbox operations stay rejected. This application never silently falls back to unsandboxed Cursor execution.

The deployment requires one trusted local OS account. Other processes running as that account may access its files and local UI. Do not expose the UI through a tunnel or reverse proxy without adding a separate authenticated control plane.

Report vulnerabilities privately to the repository maintainer. Include a minimal reproduction without real keys, phone numbers or message contents.

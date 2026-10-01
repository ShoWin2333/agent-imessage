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

## Telemetry dependency remediation

The production audit's 13 moderate package findings shared one advisory, [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf): inbound W3C baggage parsing in `@opentelemetry/core <2.8.0` could allocate excessive memory. These packages are production dependencies through Spectrum and Photon, not development-only dependencies. Presence in the dependency graph does not establish that an untrusted baggage header reaches this Gateway's propagator.

| Audited package | Installed version before remediation | Dependency path / source of finding |
| --- | --- | --- |
| `@spectrum-ts/core` | 12.7.0 | Direct production dependency → Photon telemetry |
| `@spectrum-ts/imessage` | 12.7.0 | Direct production dependency → Photon telemetry |
| `@photon-ai/otel` | 3.6.0 | Spectrum → telemetry SDKs and exporters |
| `@opentelemetry/core` | 2.7.1 | Photon / exporters → vulnerable baggage parser |
| `@opentelemetry/exporter-logs-otlp-http` | 0.218.0 | Photon → core / exporter base / transformer / logs SDK |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.218.0 | Photon → core / exporter base / transformer / resources / metrics SDK |
| `@opentelemetry/exporter-trace-otlp-http` | 0.218.0 | Photon → core / exporter base / transformer / resources / trace SDK |
| `@opentelemetry/otlp-exporter-base` | 0.218.0 | Exporters → core / transformer |
| `@opentelemetry/otlp-transformer` | 0.218.0 | Exporters → core / resources / SDKs |
| `@opentelemetry/resources` | 2.7.1 | Photon / exporters / SDKs → core |
| `@opentelemetry/sdk-logs` | 0.218.0 | Photon / transformer → core / resources |
| `@opentelemetry/sdk-metrics` | 2.7.1 | Photon / exporters / transformer → core / resources |
| `@opentelemetry/sdk-trace-base` | 2.7.1 | Photon / exporters / transformer → core / resources |

The override pins only stable `@opentelemetry/core` to **2.8.0**, the first upstream fix. Photon permits stable core `^2.7.1`, but the 0.218.0 exporters and SDKs pin core exactly to 2.7.1; updating Photon's own copy alone leaves vulnerable nested copies. The override also unifies optional Undici instrumentation's previous safe core 2.9.0 at 2.8.0, within its declared `^2.0.0` range. No Spectrum downgrade, experimental API upgrade or audit exclusion is used. All other dependency versions remain unchanged. npm applies overrides only from the installation root: the macOS packager and extracted-tarball smoke test use this application's manifest as that root. Consumers installing this package as a dependency must apply the override in their own root manifest.

The [stable 2.8.0 release](https://github.com/open-telemetry/opentelemetry-js/releases/tag/v2.8.0) preserves the previous public exports and adds `hrTimeToSeconds`; it introduces baggage limits of 180 entries, 8192 aggregate characters and 4096 per entry. Regression tests resolve core from the actual nested/hoisted consumers, verify ordinary values and metadata plus string/array limits, and export synthetic Photon traces, logs and metrics to a loopback collector. Reassess/remove the override when Photon adopts fixed dependency pins. The production audit threshold is unchanged.

The full development audit also identified `vitest` and `@vitest/mocker` 3.2.7 under [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9). Vitest is now pinned to **4.1.11**, the first stable fix, with its matching mocker and internal packages; upstream does not plan a 3.x backport. The compatible Vite 7.3.6 toolchain is retained. All 176 existing tests pass without assertion or fixture changes, including recovery, deduplication, worker lifecycle and telemetry security checks. Full and production audits report no vulnerabilities. `npm run audit:all` fails on moderate-or-higher advisories across production and development dependencies; the existing production audit command remains unchanged. Vitest remains a development dependency absent from the production tarball installation; the repository runs Node tests with `vitest run`, without browser mode or public `mockerPlugin`/`interceptorPlugin` integration.

## Telegram

Telegram uses the fixed HTTPS Bot API origin with redirects disabled. Bot Tokens are held in the private secrets file and provider errors are sanitized so token-bearing request URLs do not reach runtime status. Only private messages whose sender and chat IDs both match the configured owner are admitted; groups, other users, bots and edited updates are ignored. Inbound attachments and captions are not executed. One bot may bind to one channel only, preventing competing update consumers inside a configuration. Bot/owner identity participates in state isolation. A separate application using the same bot can still conflict with polling and must be stopped separately.

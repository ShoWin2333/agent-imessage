# dsh-imessage: Make DSH genuinely useful from iMessage

[中文](./README.md) | **English**

This fork connects DeepSeek Harness (DSH) to iMessage. Beyond remote text conversations, it lets DSH send **images, arbitrary files, and native voice messages** directly back to the active iMessage conversation.

> DSH is no longer limited to returning a text answer. It can deliver charts, documents, archives, and audio from the workspace straight to your phone.

## What this fork adds

These are the main improvements over the upstream [`photon-hq/dsh-imessage`](https://github.com/photon-hq/dsh-imessage), and they are the headline features of this repository.

| Capability | Result |
|---|---|
| **Send images** | DSH can send PNG, JPEG, GIF, WebP, HEIC, and other recognized images from the workspace; Messages renders them inline. |
| **Send arbitrary files** | PDFs, text files, CSV, JSON, ZIP archives, and other regular files can be delivered as iMessage attachments. |
| **Send native voice messages** | MP3, M4A, WAV, AIFF, AAC, CAF, and OGG audio can be delivered as native iMessage voice bubbles instead of local file paths. |
| **A separate workspace per route** | Each iMessage number can target an absolute project directory where DSH works and resolves outbound files. |
| **A separate Photon project per route** | Photon project names are configurable, preventing multiple machines or projects from sharing one cloud project and hosted line. |
| **Multiple iMessage routes on one computer** | Every route has its own Photon project, workspace, hosted number, listener, and active DSH session. |
| **More resilient Photon setup** | Safe same-origin redirects and a create-by-name fallback reduce opaque project-listing failures during setup. |

Legacy single-route settings migrate automatically into one default route.

### Use outbound media directly from iMessage

You can ask DSH naturally:

- “Send me `reports/allocation.png`.”
- “Send me the PDF you just created and the original CSV.”
- “Send this audio as a voice message.”

During a turn initiated from iMessage, the model can call:

- `send_imessage_file` to send an image or any regular file;
- `send_imessage_voice` to send a native iMessage voice message.

Media must be inside the route's workspace and is limited to 20 MiB by default. The plugin rejects paths outside the workspace, symlink escapes, directories, and oversized files. Media can only be sent back to the DM that triggered the current turn; a browser-originated turn cannot unexpectedly send an attachment to the phone.

Native iMessage voice messages may show “Expires in 2 min.” This is Apple's audio-message retention policy, not a delivery failure. Tap **Keep**, or choose **Never** under iPhone **Settings → Apps → Messages → Audio Messages → Expire**.

### Current media boundary

- The current release supports outbound **DSH → iMessage** images, files, and voice messages.
- Inbound media is not implemented yet: images, files, and voice messages sent from the iPhone to DSH are ignored.
- The plugin sends existing files; it does not itself generate images or synthesize speech. DSH may create a file with another tool before calling the send tool.
- Final text answers are still converted to iMessage-friendly plain text rather than sending raw Markdown markers.

## Install this fork

The unqualified `dsh-imessage` package on npm refers to the upstream release and may not contain this fork's enhancements. To use the image, file, voice, and multi-route features from this repository, build and install the fork locally:

```sh
git clone https://github.com/ShoWin2333/dsh-imessage.git
cd dsh-imessage
npm ci --legacy-peer-deps
npm run build
npm pack
```

If an upstream package or an older build with the same version is already installed, remove it first so the package manager does not reuse the cached artifact:

```sh
dsh plugin --profile web remove dsh-imessage
dsh plugin --profile web add ./dsh-imessage-*.tgz
dsh web
```

If DSH runs under launchd or another persistent service, restart that service after installation.

### Compatibility target

- DeepSeek Harness `0.1.5-rc.1` (current official latest / next)
- Spectrum `12.7.x` (currently pinned to `12.7.0`)
- Node.js `22.19+` or `24+`

## Configure routes

Open **Settings → iMessage**:

1. Select **Authorize** and complete Photon device authorization.
2. Add or edit a route and set its local workspace, Photon project name, and sender phone number.
3. An empty workspace uses the `dsh web` process directory; an empty Photon project name uses `dsh`.
4. Save the E.164 phone number that will text the hosted line. The same personal number may be reused across routes.
5. Copy the hosted iMessage number assigned to the route and message it from the configured personal number.

Use a different Photon project name for each route. Photon assigns a separate hosted line to each project, while the local plugin maintains an independent listener and active session for every route.

## Capabilities inherited from upstream

The following foundation comes from the upstream plugin and remains available in this fork:

- receive text through a Photon-hosted iMessage number and enqueue it in DSH;
- complete Photon device authorization, phone setup, and runtime inspection in DSH Settings;
- deliver DSH's final answer back to the same iMessage DM;
- create, list, and switch root sessions in the same workspace;
- handle DSH approval requests and interactive questions through iMessage;
- persist replay deduplication, reconnect listeners, and split long Unicode text safely;
- isolate credentials, routes, and current-turn delivery with fail-closed checks.

## iMessage commands

Ordinary text is queued as a DSH prompt. Prefix a prompt that genuinely starts with `/` using `//`, for example `//review this route`.

| Command | Behavior |
|---|---|
| `/help` | Show command help. |
| `/new` | Create and select a new root session. |
| `/sessions [page]` | List same-workspace root sessions, five per page by default. |
| `/switch <index\|session-id>` | Select a session by list index, exact ID, or unique ID prefix. |
| `/status` | Show the active session and its current state. |
| `/stop` or `/cancel` | Cancel the running turn and invalidate prompts still waiting in the iMessage FIFO. |
| `/approve <request-id>` | Approve a request correlated with the current iMessage turn. |
| `/deny <request-id>` | Reject a correlated request. |
| `/answer <request-id> <option-or-text>` | Answer a correlated question; commas select multiple numbered choices. |

`/new` and `/switch` fail while an iMessage prompt is queued or running, or while a human interaction is pending. Send `/stop` first.

## Routing and privacy boundaries

An inbound message is accepted only when all of these checks pass:

- the platform is iMessage and the direction is inbound;
- the conversation is a direct message;
- the sender equals the E.164 number configured for the route;
- a dedicated connection's recipient matches the hosted line, or Photon already isolated the message through the project's shared route;
- when the provider includes a service field, it is iMessage;
- the inbound content is text.

Unauthorized traffic is ignored without a reply. The plugin does not log message content, raw phone numbers, device codes, access tokens, or project secrets. The host persists only non-secret route settings, one opaque Photon credential object, the active session ID per route, and a bounded inbound-message deduplication window.

Every iMessage prompt is correlated by its exact DSH `UserMessage.id`. Only after DSH claims that message does the turn gain permission to send text, attachments, voice messages, approvals, or questions to that iMessage conversation. Browser-originated turns in the same Agent remain in the browser.

Only the final answer is sent to iMessage. Intermediate reasoning, tool activity, and partial output remain in DSH. Long answers split near paragraph, line, or word boundaries without splitting Unicode grapheme clusters.

## Photon resource behavior

The plugin implements the Photon CLI-compatible RFC 8628 device flow over HTTPS. It does not launch the Photon CLI or read CLI credential files. Project and user management follows these rules:

- reuse an accessible Photon project with the exact configured name, creating a US/iMessage project only when no match exists;
- report public IDs for ambiguous projects or users instead of choosing arbitrarily;
- prepare a replacement phone and Spectrum connection before switching the live route, so a failed replacement leaves the old listener working;
- disconnect locally without deleting Photon cloud projects, users, or hosted lines;
- allow an existing project secret to continue routing after the management token expires, while requiring reauthorization for project or user changes.

## Host configuration

These host-only options are not exposed in the Settings page:

| Option | Default |
|---|---:|
| `photonApiOrigin` | `https://app.photon.codes` |
| `interactionTimeoutMs` | `600000` (10 minutes) |
| `maxOutboundChars` | `3500` graphemes |
| `maxOutboundMediaBytes` | `20971520` (20 MiB) |
| `sessionsPerPage` | `5` |
| `dedupeEntries` | `1024` |
| `reconnectMinMs` | `1000` |
| `reconnectMaxMs` | `60000` |

Override the bundle row in the web profile's `cordis.patch.yml`. DSH patch overrides replace the entire row, so preserve both `id` and `name`:

```yaml
- id: dsh-imessage
  name: dsh-imessage
  config:
    interactionTimeoutMs: 900000
    maxOutboundChars: 3000
    maxOutboundMediaBytes: 31457280
```

Non-HTTPS Photon API origins are rejected except for loopback HTTP used in tests.

## Limitations

- One Photon account is used per plugin instance, although multiple iMessage routes are supported.
- Inbound handling is currently text-only; inbound attachments, voice, reactions, group chats, SMS, and RCS are ignored.
- Outbound delivery supports final text, regular file/image attachments, and native voice messages, but has no built-in image generation or text-to-speech.
- The same personal phone number may be reused across routes, but every route still needs its own hosted line.
- `/sessions` and `/switch` expose only root sessions whose workspace matches exactly; subagents are excluded.
- Photon cloud resources are not cleaned up automatically.

## Troubleshooting

| Error or symptom | Action |
|---|---|
| The image or voice tool is not called | Confirm that the current prompt originated from iMessage rather than the Web session. |
| The file is outside the workspace | Copy it into the workspace configured for that route before sending. |
| Voice displays `00:00` | Install a build containing this fork's voice-container fix, removing an older same-version package before reinstalling. |
| Voice displays “Expires in 2 min” | Tap **Keep**, or set iPhone Audio Messages expiration to **Never**. |
| `invalid-phone` | Use `+`, a non-zero country-code digit, and at most 15 total digits without spaces or punctuation. |
| `auth-expired` / `auth-denied` | Start Photon authorization again and complete it before expiry. |
| `authorization-required` | Reauthorize Photon; current routing may continue while the project secret remains valid. |
| `project-ambiguous` | Rename duplicate projects until exactly one name matches. |
| `shared-line-unavailable` | Request Photon shared capacity or configure a dedicated allocation. |
| `runtime-failed` | Use **Retry listener**; if it repeats, inspect the Photon project's iMessage platform and hosted line. |

## Development and verification

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack --dry-run
# With an 0.1.5-rc.1 DSH binary available:
DSH_BIN=/path/to/dsh npm run test:profile
```

The test suite covers device-flow backoff and cancellation, secret redaction, Photon project/user idempotency, ingress filters, replay deduplication, reconnects, Unicode chunking, exact turn ownership, approval/question fail-closed behavior, session lifecycle, media path containment, file-size limits, attachment/voice adaptation, and the interactive Settings UI.

The repository contains CI workflows for Node 22.19 and Node 24, plus a smoke test that installs the packed artifact into a disposable DSH web profile. Whether those workflows execute in a fork depends on that repository's GitHub Actions settings.

## Publishing note

This fork still uses the upstream npm package name `dsh-imessage`. The inherited release workflow and npm Trusted Publisher were originally bound to `photon-hq/dsh-imessage`; they do not automatically grant the fork permission to publish the upstream npm package. Until the fork has its own package name and publishing configuration, distribute it as a local tarball or through the fork's own GitHub Releases.

## Upstream and references

- [Upstream dsh-imessage](https://github.com/photon-hq/dsh-imessage)
- [This fork](https://github.com/ShoWin2333/dsh-imessage)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Photon CLI authentication](https://photon.codes/docs/cli/authentication)
- [Spectrum TypeScript getting started](https://photon.codes/docs/spectrum-ts/getting-started)
- [Spectrum iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)

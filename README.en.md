# Messaging Channels · DSH channel plugin

**The default `main` branch now contains the DSH channel plugin. The old standalone macOS App is preserved in `archive/standalone-macos-main-20261104`.**

A DeepSeek Harness plugin for iMessage, Telegram, Weixin iLink and QQ Bot. This version targets DSH `0.2.2-rc.1` only, using matching SDK dependencies.

DSH owns agents, models, tools, permissions, inboxes, cancellation and durable session logs. This plugin owns verified channel bindings, provider-message deduplication and reply delivery. It exposes the Cordis `name / inject / apply` entry point, with no standalone application, backend bridge, desktop shell, service installer or executable CLI.

One read-only Agent tool, `channel_status`, reports each configured channel's enabled flag, connection phase and stable error code, without message content, credentials or session identifiers. The plugin does not load when the Host provides no `tools` service.

**This working tree removes Discord and Feishu; the removal has not been published. The published `1.1.0-dsh.13` package still contains the retired channels. The install commands below do not install these unpublished changes.** See [safe handling of old configurations](docs/dsh-channel-migration.md#removed-channel-configurations).

## Install

The source version is **`1.1.0` (unpublished)**. The DSH plugin is now `main`, so versions use ordinary SemVer without the `-dsh.N` suffix previously used to distinguish the standalone macOS App. The package remains `@showin2333/dsh-plugin-channels`; the old App stays archived, and existing releases and Git tags are retained. Stable `1.1.0` sorts above the earlier `1.1.0-dsh.N` prereleases.

This version supports DSH `0.2.2-rc.1`. The iMessage channel additionally requires macOS with Messages; Telegram, Weixin iLink and QQ Bot are cross-platform.

The npm package is `@showin2333/dsh-plugin-channels`. Installing it mounts two Cordis rows as a bundle (`dsh-channels` and the project grouping); the browser panel is discovered from `dsh.client`.

This package replaces `@showin2333/dsh-channels`. Keep existing row IDs, channel bindings and session records when switching. Stop the old bundle before replacing dependency/module references; do not load both names together. See the migration guide.

The current published release is `1.1.0-dsh.13`; this local removal does not change the published package or online market index.

- **Direct install**: DSH → Plugins → Install, then enter `@showin2333/dsh-plugin-channels@1.1.0-dsh.13`.
- **Market install**: enable `@deepseek-ai/dsh-experimental-plugin-market-bundle`, then Plugins → Discover → Add index source with the URL below.
- **Local development**: `pnpm install && npm run build`, then point the profile dependency at this checkout with `link:`.

Market index: `https://cdn.jsdelivr.net/gh/ShoWin2333/agent-imessage@main/market/index.json`

Nothing connects until you configure a workspace, permission preset and credential reference in **Settings → Messaging Channels** and enable the binding. Upgrading means uninstall followed by install; DSH has no in-place update action yet.

Idle messages enter native DSH follow-up turns; refinements steer the next step only while this channel owns the active turn. Host-originated turns keep their approval and reply ownership. There is no fixed progress-text receipt. Admission waits for inbox durability. Native `claimed` events correlate input IDs with turns; results are delivered after `turn/end` and an explicit flush. `/cancel` and `/stop` cancel current and queued work for this binding. `/status` reports its session; `/help` lists commands.

Restart recovery delivers completed unsent results without rerunning prompts. Interrupted old input is quarantined and removed from the resumed inbox before accepting new work. Ambiguous sends are marked `uncertain` and never retried automatically. This does not promise end-to-end exactly-once delivery.

The bundle patch loads an inert plugin until explicit bindings are configured. Bindings specify an existing absolute workspace, channel account and owner, an existing host permission preset, and a credential reference. Tokens never belong in the plugin configuration. One consumer per external account/project is required.

Existing adapters retain owner/destination filtering, typing, text splitting and attachment send methods. The minimal task path is text only. For a DSH session bound to Telegram, Weixin, or iMessage, the desktop and the fixed bound channel answer the same request. Telegram uses buttons. Weixin and iMessage use short reply commands. The first valid decision settles it once. Settlement cancels the other presentation: the native desktop card withdraws through its cancellation signal, and channel controls or status messages reflect the final result. A failed external message update does not restore a reply token, and late answers cannot authorize a second execution. Unbound desktop conversations keep their native approval path. See the migration guide for answerer composition limits. The DSH session policy determines whether approval is needed. Questions delegate to DSH first and fall back to the originating channel on native NO_PROVIDER. Channel tokens expire after two minutes without expiring the native desktop request; prompts show expiry and final settlement status. Tokens are invalidated on cancellation, disconnection, turn completion, unload and restart. Commands require explicit tokens; replay and malformed answers never become model prompts. Channel-owned Agents can now call `channel_send_media` with `path` (an existing file inside the binding workspace, at most 20 MiB) and `kind` (`image`, `file`, or `voice`). Uploads require native approval and the Agent-composed filesystem; there is no arbitrary recipient parameter. Media receipts are committed before sending and ambiguous delivery is never automatically retried. Voice sends existing audio, not synthesized speech. Native scheduling and multimodal task ingress remain future work.

Desktop includes an independent **Settings → Messaging Channels** sidebar section (macOS **⌘,**): four channel types, project directory, host model/effort selection, credential references, identity bounds, runtime status, explicit start/stop and revision-aware save/cancel. Choose an Agent/project on the left, then its channel. Running channels support drafts; applying an execution change explicitly reconnects only that channel and retains its old sessions. Saves/cancels are per-channel, with host-default or channel-specific model selection. Native Workspace membership attaches exact plugin-owned sessions and future sessions to their project. New bindings stay disabled. Credential names do not confirm configured values. Runtime rejects invalid external settings before reconciling consumers; rejected persisted settings must be repaired before restart. Settings uses a declarative native schema because executable transforms do not survive the host's second serialization.

Agent groups are persistent plugin configuration. **Add Agent** saves a name and default project directory, including an empty group; new channels inherit this directory and start disabled. Individual channels retain their own model, directory and permission settings. The group directory only prefills new channels; the selected channel’s DSH project comes from Host-reported membership and is unaffected by an unsaved directory draft. Creating a group does not create a running native DSH Agent.

**Remove channel** removes one channel configuration and keeps the empty Agent when it was the last channel. **Remove Agent** removes the group and its channel configurations. Confirmation lists the affected channels and which enabled connections will stop, and warns about discarded drafts. Session histories, Host credentials, project files and DSH Workspace metadata are kept. The Host performs channel teardown after accepting the configuration.

The separate `agents` array stores `id`, `name`, `cwd` and `bindingIds` (at most 32 groups). Bindings without metadata retain the previous prefix/directory grouping until the next save persists it. Group metadata never enters binding identity, preserving channel IDs, session keys, deduplication and receive cursors. Groups and bindings are submitted in one revision-checked Settings transaction; changed targets invalidate a pending removal confirmation. Only saved channels listed in the confirmation may be removed from Host configuration. Local draft ids are used only for draft cleanup; a draft id concurrently saved as a channel requires a fresh confirmation.


See the [configuration examples](README.md) and [migration guide](docs/dsh-channel-migration.md). To validate locally:

```sh
# pnpm 11.28.5 (verified Desktop bundled version)
pnpm install --frozen-lockfile --ignore-scripts
npm run check
```

Tests use synthetic messages and mocked provider requests; no live sending, login, model calls or service changes. The migration leaves existing installations and user histories untouched. Rollback uses Git and an installation backup, rather than keeping a second product entry point.


QQ Bot was rebuilt from the QQ-free baseline using Tencent’s official SDK and DSH plugin reference. It includes QR binding, owner-only private chats, media, streaming, session commands and native shared approvals. See [the feature comparison and integration requirements](docs/qqbot.md) and [validation record](docs/qqbot-validation.md). These changes are unpublished; the local build has been installed for user testing. Automated tests use synthetic credentials and mocked requests.

# Message Channels · DSH channel plugin

**Long-lived plugin branch: `dsh-plugin`. The independent macOS App stays on `main`; do not merge this branch into `main`.**

A DeepSeek Harness plugin for iMessage, Telegram, Weixin iLink and Discord. Targets the DSH `0.2.1-rc.2` interfaces; `engines.dsh` accepts `>=0.2.1-rc.2 <0.3.0` while dev dependencies stay pinned to the verified RC.

DSH owns agents, models, tools, permissions, inboxes, cancellation and durable session logs. This plugin owns verified channel bindings, provider-message deduplication and reply delivery. It exposes the Cordis `name / inject / apply` entry point, with no standalone application, backend bridge, desktop shell, service installer or executable CLI.

One read-only Agent tool, `channel_status`, reports each configured channel's enabled flag, connection phase and stable error code, without message content, credentials or session identifiers. The plugin does not load when the Host provides no `tools` service.

## Install

Requires DSH `0.2.1-rc.2` (`engines.dsh` accepts `>=0.2.1-rc.2 <0.3.0`). The iMessage channel additionally requires macOS with Messages; Telegram, Weixin iLink and Discord are cross-platform.

The npm package is `@showin2333/dsh-plugin-channels`. Installing it mounts two Cordis rows as a bundle (`dsh-channels` and the project grouping); the browser panel is discovered from `dsh.client`.

This package replaces `@showin2333/dsh-channels`. Keep existing row IDs, channel bindings and session records when switching. Stop the old bundle before replacing dependency/module references; do not load both names together. See the migration guide.

- **Direct install**: DSH → Plugins → Install, then enter `@showin2333/dsh-plugin-channels@1.1.0-dsh.10`.
- **Market install**: enable `@deepseek-ai/dsh-experimental-plugin-market-bundle`, then Plugins → Discover → Add index source with the URL below.
- **Local development**: `pnpm install && npm run build`, then point the profile dependency at this checkout with `link:`.

Market index: `https://cdn.jsdelivr.net/gh/ShoWin2333/agent-imessage@dsh-plugin/market/index.json`

Nothing connects until you configure a workspace, permission preset and credential reference in **Settings → Message Channels** and enable the binding. Upgrading means uninstall followed by install; DSH has no in-place update action yet.

Idle messages enter native DSH follow-up turns; refinements steer the next step only while this channel owns the active turn. Host-originated turns keep their approval and reply ownership. There is no fixed progress-text receipt. Admission waits for inbox durability. Native `claimed` events correlate input IDs with turns; results are delivered after `turn/end` and an explicit flush. `/cancel` and `/stop` cancel current and queued work for this binding. `/status` reports its session; `/help` lists commands.

Restart recovery delivers completed unsent results without rerunning prompts. Interrupted old input is quarantined and removed from the resumed inbox before accepting new work. Ambiguous sends are marked `uncertain` and never retried automatically. This does not promise end-to-end exactly-once delivery.

The bundle patch loads an inert plugin until explicit bindings are configured. Bindings specify an existing absolute workspace, channel account and owner, an existing host permission preset, and a credential reference. Tokens never belong in the plugin configuration. One consumer per external account/project is required.

Existing adapters retain owner/destination filtering, typing, text splitting and attachment send methods. The minimal task path is text only. Approvals and questions now use native DSH answerer waterfalls, delegating to host handlers first. Only native unavailable/NO_PROVIDER outcomes can fall back to this exact channel and claimed turn. One-shot tokens expire after two minutes and are invalidated on cancellation, disconnection, turn completion, unload and restart. Commands require explicit tokens; replay and malformed answers never become model prompts. Media tools and native scheduling remain future work.

Desktop includes an independent **Settings → 消息渠道** sidebar section (macOS **⌘,**): four channels, project directory, host model/effort selection, credential references, identity bounds, runtime status, explicit start/stop and revision-aware save/cancel. Choose an Agent/project on the left, then its channel. Running channels support drafts; applying an execution change explicitly reconnects only that channel and retains its old sessions. Saves/cancels are per-channel, with host-default or channel-specific model selection. Native Workspace membership attaches exact plugin-owned sessions and future sessions to their project. New bindings stay disabled. Credential names do not confirm configured values. Runtime rejects invalid external settings before reconciling consumers; rejected persisted settings must be repaired before restart. Settings uses a declarative native schema because executable transforms do not survive the host's second serialization.

See the [configuration examples](README.md) and [migration guide](docs/dsh-channel-migration.md). To validate locally:

```sh
# pnpm 11.28.5 (verified Desktop bundled version)
pnpm install --frozen-lockfile --ignore-scripts
npm run check
```

Tests use synthetic messages and mocked provider requests; no live sending, login, model calls or service changes. The migration leaves existing installations and user histories untouched. Rollback uses Git and an installation backup, rather than keeping a second product entry point.

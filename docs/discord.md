# Connect Discord to Agent iMessage

Discord is an optional transport for this Mac's local Agent Gateway. It runs the
configured Codex, Cursor or DSH backend in the selected workspace, using the same
task, approval, question, history, scheduling and media infrastructure. Each
channel has its own backend instance and durable session identity. Adding Discord
does not automatically share an existing iMessage session, a Codex desktop chat,
Jane, or any cloud assistant's conversation or memory.

## Library and architecture

The implementation uses the current stable **discord.js 14.27.0**, pinned in
`package.json` and the lockfile. Its published package supports Node >=18, so the
Gateway's Node 22.19+ / 24+ requirement stays unchanged. The project and its core
Discord dependencies use Apache-2.0, compatible with this project's MIT license;
their license files remain in installed packages.

Research sources:

- [Discord Gateway](https://docs.discord.com/developers/events/gateway): persistent
  events, intents, reconnect and session resume. Discord recommends using a library.
- [Discord message API](https://docs.discord.com/developers/resources/message):
  the 2,000-character content limit, allowed mentions and file uploads.
- [discord.js v14.27.0 metadata](https://github.com/discordjs/discord.js/blob/14.27.0/packages/discord.js/package.json) and its published
  npm metadata (`npm view discord.js@14.27.0 engines license dependencies`). Stable
  v14 metadata is the compatibility reference; development/main documentation may
  target a newer Node version.
- [Oceanic](https://github.com/OceanicJS/Oceanic): a maintained MIT alternative with
  Gateway and REST support. discord.js was selected for its larger ecosystem,
  typed API and established resume/rate-limit handling. This app does not implement
  Discord's heartbeat, identify, resume or rate-limit protocols itself.

`src/channels/discord.ts` adapts discord.js to `ChannelAdapter`/`ChannelMessage`.
`Gateway` supplies the existing `GatewayRouter` and `StateStore`. No public
HTTP endpoint, webhook tunnel, slash-command registration or new agent runtime
is required. The local account-verification endpoint uses discord.js REST to
check the bot identity before saving credentials.

## Setup after the updated app is installed

This change is local source code. Building it does not update the installed app.
Deployment/restarting the user's running app needs separate authorization.

1. In [Discord Developer Portal](https://discord.com/developers/applications),
   create an application with a bot (or use a dedicated existing bot). Use a bot
   token, never a personal Discord account token. Keep Public Bot disabled if
   this bot is only for your own server.
2. Install it into your server using the `bot` scope. Grant only **View Channel**,
   **Send Messages**, and **Attach Files** on the intended text channel. Do not
   grant Administrator. This integration does not register slash commands. Leave
   Message Content, Server Members and Presence privileged intents disabled.
   Owner DM mode needs no server-channel permissions after installation.
3. In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click
   your own avatar and choose **Copy User ID**. This is your numeric account ID,
   not your username, application ID or bot ID.
4. Open the updated Agent iMessage app → **消息渠道 / Message channels → Discord →
   添加 Discord Bot**. Enter the bot token in the local **secure field** and your
   user ID, then verify/save. Never paste a token into a chat, commit, screenshot,
   terminal command or issue. Tokens are stored in the existing local private
   `config.json.secrets.json` file (0600; parent directory 0700) and not returned
   by the state API. Blank input during editing retains the saved token.
5. Open your Agent → **项目配置 / Project configuration → 消息入口 / Message
   entrances → 绑定 Discord**. Select the saved bot, then choose a destination:
   - **Owner DM** (default): send the bot a direct message. Only the saved owner
     is accepted. Discord privacy settings may require allowing DMs from that
     server or sharing a server with the bot.
   - **Server text channel**: copy the server ID and exact text channel ID with
     Developer Mode and enter both. Use a private channel: other members who can
     view it can read results and approvals. Only the saved owner can submit.
     Every task, command, approval and answer must explicitly mention the bot.
     Threads, forum posts and other channels are not accepted.
6. Save/apply when the Agent is idle. Keep its configured backend/model/effort;
   this transport imposes no model selection. To run the requested model through
   Codex, select `gpt-6.1-sol` with `high` effort, subject to the local backend's
   advertised availability. Keep the original iMessage binding if desired.
7. Check the channel shows connected. In a DM send `/status`, then a short task.
   In server mode send `@YourBot /status` and `@YourBot your task`. Existing
   commands (`/new`, `/sessions`, `/switch ID`, `/stop`, `/approve ID`, `/deny ID`,
   `/answer ID {"question-id":"answer"}`) work through the same router. Server
   mode requires the mention on every one of those messages.

No Message Content privileged intent is requested: Discord exposes content in
bot DMs and explicit bot mentions without it, as documented in the Gateway docs.

### Selecting two saved bots

For each Agent, click **绑定 Discord** in its message entrances and open
**选择 Discord Bot**. The menu shows each saved bot's name and exact Bot ID.
Two different bots can use the same allowed owner User ID and still bind to
different Agents. A bot already assigned elsewhere stays visible with that
Agent's name and cannot be selected until it is unbound there and saved.

If the selector is labelled **选择Telegram账号**, it lists only Telegram accounts.
Add or expand the **Discord** entrance to select Discord bots. Saving a bot in
Message channels prepares its credentials; selecting and saving an Agent's
Discord entrance completes the binding. Existing saved credentials can be used
without entering the token again.

## Configuration example (public fields only)

Add this binding to an existing route's `channels` array; preserve existing
iMessage fields and channels. A standalone Discord route uses the same shape.

```json
{
  "id": "discord",
  "kind": "discord",
  "botId": "123456789012345678",
  "ownerUserId": "234567890123456789"
}
```

For server mode add both `guildId` and `channelId`, as quoted numeric strings.
Never use JavaScript numbers for Discord IDs. One bot can bind to one channel in
the configuration, including disabled projects. Unbind/save before moving it.
Use one Gateway installation per bot; separate applications/state roots cannot
be detected or coordinated automatically.

## Behavior and limits

- Messages from other users, bots (including self), webhooks, group DMs, system
  events, edited messages and other destinations are ignored. Only new text
  messages enter the agent. Attachments are not downloaded or interpreted;
  accompanying admitted text can still be a task.
- Every outbound message disables user, role and everyone mentions. Replies are
  plain channel sends, without pinging the original author. Long text is split
  into at most 2,000 UTF-16 code units per message, preserving graphemes.
- Existing workspace/size validation governs outgoing files; Discord adds a
  conservative **10 MiB** cap, and actual provider limits may be smaller. Audio
  uses file delivery; voice-channel joining and native voice messages are absent.
- discord.js handles Gateway reconnect/resume and REST rate limits. Startup
  network failures retry with bounded exponential delays. Invalid tokens, bot
  identity mismatches, unsupported channels, invalid intents and missing channel
  permissions fail with safe status text. Fix setup and use Start/Retry in the
  local app. Stop aborts pending REST work and fences messages from old listeners.
- The existing router records message IDs before dispatch and retains the last
  1,024 for deduplication. Duplicate events within that retention window do not
  rerun tasks. Uncertain execution or delivery is not automatically replayed.
  There is no historical catch-up after a fresh process restart. A bounded queue
  accepts up to 32 awaiting admissions; additional messages are dropped under
  overload. A normal SDK reconnect may resume missed events while the process is
  alive. Text chunks/uploads already sent cannot be recalled on cancellation.
- Bot, owner, server and destination identity participate in state isolation.
  Changes begin a fresh channel session. The backend retains its normal sandbox
  and approval policy. Keep private configuration outside agent workspaces.

## Validation and live checklist

Mocked tests cover filtering, chunking, disabled mentions, attachments, typing,
startup retry, stop/cancellation, reconnect/fatal status, configuration validation,
credential verification/redaction/storage, a Gateway task/reply round trip,
two-bot session isolation for separate Agents owned by one user, native picker
refresh with unsaved edits, restart dedupe and identity resets. They use synthetic credentials and no Discord
network connection.

Real bot setup is still required to validate a live DM and server-channel round
trip, file upload, an approval response, reconnect after network interruption,
and rejection of a second user. Also verify iMessage still receives/replies after
the separately authorized deployment. No credentials or Discord permissions were
configured by this implementation task.

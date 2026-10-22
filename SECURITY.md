# Security boundaries

This package is a same-process DeepSeek Harness plugin. DSH owns its model, tools, sandbox, approval and session-persistence services. Channel configuration is routing policy, not an OS sandbox. Each binding must select an existing host permission preset; resumed sessions retain their durable native policy. The plugin does not automatically approve tools, create credentials, log in, or install services.

Ingress remains constrained by the existing adapters:

- iMessage: configured Photon project, assigned line and sender phone number; text DM only.
- Telegram: validated bot identity and exact non-bot owner private DM; edits, other senders, groups and attachment captions do not execute.
- Weixin: exact account/owner and provider reply context; pinned HTTPS provider/CDN rules remain enforced.
- Discord: validated bot, exact owner DM, or configured guild/channel with explicit bot mention; bots, webhooks and systems do not execute. Replies disable mentions.

Binding keys include canonical workspace, account, owner, destination and permission preset. Native session IDs include that binding key. The plugin never adopts another consumer's live Agent. Changed identity creates a separate partition and cannot inherit another channel's session. The host storage domain must use a suitable durable backend; the plugin refuses Agent admission without an active native session durability listener.

Credential references resolve through the host at explicit activation. Secrets remain inside the channel adapter and are not written to settings, receipts, results or errors. The host and its trusted plugins share process privileges; this is not secret isolation against a malicious same-process plugin. Reload bindings after credential rotation. Session and reply logs contain user/model content and must inherit the host's private storage policy.

Provider IDs are deduplicated for the life of a binding. No automatic pruning occurs; at 10,000 receipts the binding refuses new admissions until explicit archival. Recovery never resubmits user prompts. Native crash-tail repair supplies an interrupted result; unclaimed old inbox input is cleared on resume. A send marked `sending` at restart or a failed/timed-out send becomes `uncertain`; there is no blind retry. A provider may have received such a message. Progress notices are best-effort, contain no tool arguments or reasoning, and are not durable delivery claims.

There must be one consumer per Photon project or bot/account across processes, profiles and machines. The plugin validates uniqueness within its own configuration; deployment-wide ownership must be arranged before activation. Do not run it beside the old consumer for the same channel.

The offline suite uses synthetic input, mock credentials/providers/Agents and temporary storage. Real profile activation, credentials provisioning, service switching and live-channel/model tests are separate operations requiring authorization. No live authentication or channel setup is performed by `npm run check`.

## Channel approval and question forwarding

The plugin never calls privileged tool operations or changes native approval policy in response to channel commands. It listens to the official answerer waterfalls. Every handler delegates first, including to host handlers registered later. Approval falls back only from `unavailable`; questions fall back only from native `UserQuestionError(NO_PROVIDER)`. Host outcomes and other errors are preserved, with no race or fallback timeout that could bypass a pending host answerer. Native DSH owns approval audit events and grant semantics.

Channel responses require an exact live registry Agent, its open claimed turn, the owning input, a healthy fixed channel binding, and a fresh high-entropy one-use token. Reply admission is persisted before resolving the native request. Approval policy is rechecked on a channel grant; `never` cannot be overridden. No always-allow or permission-preset mutation is available. Full native reason/question/plan detail is displayed, with no truncation; missing approval context or oversized content fails closed. Raw tool arguments and credentials are not read to construct prompts.

Tokens stay in memory, never in durable receipts or restart recovery. Cancellation, turn completion, Agent disposal, disconnect and unload invalidate pending waits, even without a native request signal. A late send may expose an expired token, which remains unusable. A provider send must be confirmed before a reply can authorize anything. Structured question answers require exact complete question IDs, unique valid options, and correct single/multiple selection; plan review accepts a single explicit offered option, not custom text. No default/recommended selection is inferred and bare text never grants approval.

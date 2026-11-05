# QQ Bot rebuild validation

Current local package: `1.1.0-dsh.18`, targeting DSH `0.2.2-rc.1`.
Baseline: `4f7f603` (QQ-free, Discord/Feishu removal retained).
Official reference: `tencent-connect/dsh-qqbot` `14d5eef97274e47f34f91dcaa833be994ba2a770`.

## Final automated checks

- Build passed: host compilation, generated native Remote protocol, browser compilation/bundle, and real management-panel rendering smoke check.
- Host and browser typechecks passed.
- Complete final test run: **32 files, 367 tests passed**.
- Packaging dry run passed with a workspace-local npm cache: 266 files; no retired channel runtime or private diagnostic artifacts. `git diff --check` passed. The first packaging attempt could not write npm's default cache; build, typechecks and tests had already passed and were not repeated.
- Regression coverage includes real-SDK request serialization with mocked fetch; private-owner filtering and group rejection; media and ASR ingress; QR setup lifetime; native settings acknowledgments; shared approval acceptance, expiry and duplicate clicks; approved file delivery; session identity migration; and shutdown durability.
- Tests use synthetic credentials/messages and mocked provider requests. They do not log in, send real messages or invoke paid models.
- The existing iMessage/Telegram/Weixin adapters and shared approval broker remain unchanged from the QQ-free baseline.

## Native installation and user testing

The local package was installed on the Mac mini running DSH `0.2.2-rc.1`. Native settings displayed the official QR code and binding link, accepted normalized settings without false draft conflicts, and displayed the actual installed plugin version and controller start time.

The installed .18 settings contain only owner-private QQ controls. Retired group fields were removed from the local profile while retaining existing private storage keys and Session IDs. Existing channel bindings and histories were preserved. QQ displayed connected, and a subsequent read-only native UI check confirmed Telegram had recovered to connected. The user confirmed QQ approval was working.

This is not a complete live-platform acceptance matrix. Fresh-card client rendering, all media formats, automatic file delivery, model commands, reconnects and proactive-send quotas still require live verification with the intended bot's platform permissions. Older cards are not rewritten. See [feature comparison and integration requirements](qqbot.md).

## Verified fixes

- Native schema defaults are normalized before comparing a save acknowledgment with its draft. The count distinguishes saved channels from unsaved drafts instead of presenting the 32-binding limit as a channel count.
- Approval callbacks acknowledge the existing broker's actual accepted/rejected result. A neutral visited label cannot claim authorization on an expired card; matching short references link cards with final outcomes. Fixed-owner checks, native permission policy and the existing channel expiry remain in force.
- Presentation defaults no longer change QQ session identity. Migration copies only an exact existing routing account, retains its original Session ID/scopeKey, and preserves source accounts and histories without merging transcripts. Owner and permission changes remain isolated.
- Session teardown waits for in-flight final flushes, lets SDK disposal drain, and reads the persisted completion/cancellation boundary. Unconfirmed outcomes remain uncertain and are never resubmitted automatically.

A separate machine-local legacy session-query repair used the application's official migration after normalizing an invalid historical origin annotation. Original log bytes and permission preset values were retained. That repair, profile snapshots, credentials and private diagnostic artifacts are not part of this repository or PR.

No npm publication, merge, host binary modification or host security-setting change was performed. Connector package distribution authorization remains a release prerequisite documented in `qqbot.md`.

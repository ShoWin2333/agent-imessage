# Agent iMessage

本仓库分成两条并行产品线：

| 产品 | 适用环境 | 位置 |
| --- | --- | --- |
| **macOS App / Gateway** | macOS 原生 App，独立运行 Cursor / Codex / DSH backend | 仓库根目录（本 README） |
| **DSH iMessage 插件** | 跑在 DSH Web 里的原始插件，支持 **Windows / Linux / macOS** | [`apps/dsh-imessage`](./apps/dsh-imessage) |

Windows 请使用 DSH 插件，不要运行 macOS App。两条线共用 Photon iMessage 传输思路，但配置、UI 和进程模型互相独立。

独立运行的本地 Agent App / Gateway。用 iMessage 操作本地项目，在 macOS SwiftUI 原生界面 中管理 Cursor、Codex 和 DSH。无需启动 Cursor Desktop、Codex Desktop 或 DSH Web。

```text
iMessage ↔ Photon / Spectrum ↔ Gateway
                              ├─ 路由、授权号码、重连、消息去重
                              ├─ 会话、取消、审批 / 提问、文件 / 图片 / 语音
                              ├─ 私有配置、凭据、状态、本机 API
                              └─ Backend
                                 ├─ Cursor：官方 @cursor/sdk，本地沙箱执行
                                 ├─ Codex：codex app-server，stdio
                                 └─ DSH：dsh --profile acp，无界面子进程
```

Cursor 不再使用 CLI / ACP。DSH 的 ACP 是 DSH 自身的无界面执行协议，不承担 Gateway 的配置、UI 或 Photon 生命周期。

## 启动

需要 Node.js **22.19+（22 系列）或 24+**，以及所选 backend 的账号。iMessage 需要 Photon 项目；只使用微信无需 Photon。

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run build
npm start
# 或安装本地构建的包
npm install -g . --ignore-scripts
agent-imessage start
```

启动 macOS 原生 App（开发运行：`./script/build_and_run.sh`）。`npm start` 只启动 Gateway API，不提供网页界面。在 App 添加一个或多个项目，填写：

- backend、项目工作目录的绝对路径、模型和推理参数；
- Photon 项目 ID、你的授权手机号和 Photon 分配的号码（均为 E.164）；
- Photon Project Secret，或保存该 secret 的环境变量名。

可以在页面授权 Photon，然后按项目创建 / 获取共享号码；也可以填写已有项目。共享号码必须用**手机号身份**发送 iMessage，邮箱身份不会被 Photon 路由。

每条路线需要不同的 ID 和 Photon 项目；同一发送号码 + 接收号码组合不能分给多个项目。不要同时让旧 App、旧插件和 Gateway 消费同一个 Photon 项目。

名称、头像、定时计划保存后立即生效，不会打断任务。模型参数下次任务生效。目录、权限、身份绑定和凭据变更需先停止受影响项目；无关项目保持运行。本机 API 仅监听 loopback，不提供 LAN 访问。

## 个人微信（iLink）与多个消息入口

在本地设置页点击「微信扫码绑定」，用个人微信扫描二维码并确认；如果微信要求配对码，在页面输入微信显示的配对码。绑定后，在项目中点击「添加微信入口」，选择机器人并保存。只使用微信时，取消勾选「启用 iMessage」，无需填写 Photon 信息。

一个项目选择一个 backend，可以同时绑定 iMessage 和多个微信机器人。每个入口有独立的 backend 实例、会话、消息去重、任务和审批；同一机器人只能绑定一个项目。微信只接受扫码绑定者的私聊，其他发送者不能启动任务或回答审批。Gateway 按真实工作目录协调执行：同一目录（包括符号链接别名）只允许一个任务运行，不同目录可以并行。这不锁定外部编辑器。

微信目前支持文字任务、`/new`、`/status`、`/stop`、会话切换、审批与提问，以及工作目录内文件回传（20 MiB 上限，仍受微信平台限制）。图片和音频可以作为文件回传；暂不支持原生语音发送，也不处理图片、语音或文件输入，会提示改用文字，不执行不完整的附件提示。

扫码凭据仅保存在本机 `config.json.secrets.json`（0600），不返回页面；二维码由本机生成，不使用外部二维码服务。接收使用主动长轮询，无需公网回调。微信登录失效会在入口状态显示，重新扫码即可更新绑定。真实账号可用性以扫码和实际收发结果为准。

新增配置可使用 `channels`，旧版扁平 iMessage 配置仍可直接读取：

```json
{
  "id": "my-project",
  "cwd": "/absolute/project",
  "backend": "codex",
  "channels": [
    { "id": "wechat", "kind": "weixin", "accountId": "扫码后返回的机器人 ID" },
    { "id": "imessage", "kind": "imessage", "projectId": "photon-project-id",
      "projectSecretEnv": "MY_PHOTON_SECRET", "senderPhoneNumber": "+15551234567",
      "assignedPhoneNumber": "+15557654321" }
  ]
}
```

将旧项目在 UI 添加微信入口时，原有 iMessage 身份字段会保留，继续使用原来的会话状态。手动迁移时，也应保留这些字段以及 `imessage` 入口 ID，以保留旧会话。新的入口不会继承其他入口的会话。协议参考和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 实时对话与活动

每个项目默认打开聊天式「对话与活动」，每 3 秒刷新。每条消息下方展示回复和可展开的执行步骤；运行时显示当前阶段及耗时，方便区分“网关尚未收到”“等待后端活动”和“回复发送失败”。

每个入口最近 200 条活动保存在本机私有状态文件中，重启后可回看；文本长度有限，具体保留范围见下文「聊天式监看与定时任务」。监看只覆盖通过渠道授权过滤、进入网关的消息及后端实际提供的事件，不包含模型内部推理。渠道接口返回成功不表示对方已读，分段发送失败时可能已有部分消息发出。

## Backend 准备

| Backend | 所需运行环境 | 模型参数 | 执行与权限 |
| --- | --- | --- | --- |
| Cursor | 本项目安装的 `@cursor/sdk@1.0.31`；在 UI 保存 API key，或设置 `CURSOR_API_KEY` | 模型 ID、effort、speed；`cursorMode` 可在配置中设为 `agent` / `plan` / `ask` | SDK local runtime，默认启用沙箱并加载项目规则；不启动 Cursor CLI |
| Codex | `codex` CLI 可执行文件；提前完成 `codex login` | `model`、`effort` | 独立 App Server；`workspace-write`；可选择 `on-request` / `never`，并支持 Codex 自动审核 审批策略 |
| DSH | 安装完整的 DSH CLI（验证版本 `0.1.5-rc.1`），预先配置模型凭据 | ACP 的 model option 值、`effort` | 独立 `dsh --profile acp`；显式 `DSH_PERMISSION_MODE=workspace-write` |

Codex / DSH 是可选的外部 backend：只使用 Cursor 时不需要安装它们。`codexBinary`、`dshBinary` 可以写可执行文件绝对路径，适用于后台服务的 PATH 与交互终端不同的情况。DSH model 值由其 ACP 模型目录决定，可能包含 provider 前缀。

Cursor 修改 effort / speed 时必须填写模型 ID；不把无模型的参数覆盖静默忽略。

Cursor SDK 目前没有可供本 App 接管的通用原生工具审批回调。沙箱拒绝的操作保持拒绝，不会自动提升权限；`/approve` 不能覆盖 SDK 沙箱。共享 `ask_imessage_user` 工具仍可通过 `/answer` 完成人机交互。`ask` 模式禁用内置 Agent 工具。

## 后台常驻

macOS：

```sh
agent-imessage service install /absolute/path/config.json
# 使用默认配置可以省略路径
agent-imessage service install
# 移除服务，保留用户配置和会话
agent-imessage service remove
```

LaunchAgent 名称为 `app.agent-imessage.gateway`。登录后启动，进程失败后重启；不依赖编辑器或终端保持打开。日志在配置文件旁的 `logs/gateway.log`。安装使用当前 Node.js 和 CLI 的绝对路径，移动安装目录或更换 Node.js 后应重新安装服务。已有同名服务不会被静默覆盖。

Linux 可以由 systemd 等进程管理器运行 `agent-imessage start /absolute/path/config.json`；内置 service 安装器目前仅支持 macOS。

macOS 主界面使用 SwiftUI（不再内嵌 WKWebView），通过本机 API 连接现有 Node.js Gateway。项目默认打开「对话与活动」，支持展开、搜索和按渠道筛选；「项目配置」提供模型、权限、头像和消息入口编辑。「消息渠道」提供微信扫码与 Photon 授权；`⌘,` 打开独立设置窗口。轮询不会覆盖未保存的项目草稿，配置版本冲突会保留编辑并提示重新载入。Web UI 和浏览器入口已移除。

原生窗口提供窗口位置恢复、编辑快捷键、重新连接。菜单栏常驻入口显示连接状态、工作空间数量、处理状态或失败提示，可打开完整管理界面、重新连接或退出。关闭窗口保留服务并隐藏 Dock 图标，从菜单栏重新打开后恢复 Dock；最小化仍遵循系统行为。正常退出只停止有归属证据的自有服务，外部服务保持运行。重新连接不会重载已经打开的管理页面，避免丢失未保存表单。

开发时可使用 Codex 的 Run 按钮，或执行：

```sh
./script/build_and_run.sh --verify
```

脚本会优雅退出已有窗口、构建并打开新的 `.app`。需要支持 macOS 14+ 的 Swift 工具链；新版本 SwiftUI SDK 的编译器插件需要完整 Xcode。若系统选择的是 Command Line Tools，构建脚本会优先使用 `/Applications/Xcode.app`（不修改系统选择，显式 `DEVELOPER_DIR` 优先）。已有 LaunchAgent 配置会被复用；没有时会生成仅在 App 内使用的服务 plist，不注册登录启动。支持配置中的固定端口，不能使用 `port: 0`。可用 `AGENT_GATEWAY_CONFIG` 指定首次构建时的配置路径，或用 `AGENT_GATEWAY_SERVICE_PLIST` 指定已有 plist。

也可只构建：`node scripts/macos/build.mjs '/tmp/Agent iMessage.app'`。这是依赖本机 Node 和当前仓库的开发 App。

### 独立 macOS App

```sh
npm run package:macos -- '/tmp/Agent iMessage.app'
npm run test:macos:package -- '/tmp/Agent iMessage.app'
```

发布构建内置官方 Node 22.23.2（下载后验证固定 SHA-256）、锁文件中的生产依赖、Gateway 和网页资源。需要联网、npm 和 Xcode Command Line Tools 来构建；运行 App 不需要安装 Node，也不依赖源码目录。按构建机器架构生成 Apple Silicon 或 Intel 包，不是通用二进制。输出路径已存在时拒绝覆盖。

原生窗口生命周期测试使用专用身份和空配置，避免连接真实渠道：

```sh
AGENT_GATEWAY_APP_NAME='Gateway Standalone Test' AGENT_GATEWAY_BUNDLE_ID=app.agent-imessage.standalone-test npm run package:macos -- '/tmp/Gateway Standalone Test.app'
npm run test:macos:service
npm run test:macos:store
npm run test:macos:native -- '/tmp/Gateway Standalone Test.app'
```

将 `.app` 拷贝到“应用程序”即可运行。每次启动按实际安装位置生成服务路径，退出后可以移动 App。沿用 `~/.config/agent-imessage/` 的配置、头像和凭据，以及配置指定的会话目录（默认 `~/.local/state/agent-imessage/`）；不会将构建者的配置、凭据或 LaunchAgent 放进安装包。桌面服务日志和生成的 plist 位于 `~/Library/Application Support/Agent iMessage/Desktop/`。升级时退出旧 App 后替换应用包，用户数据保留。

App 启动的服务使用独立随机 launchd label，并在私有目录中先写入归属记录，再启动服务。App 异常退出后，重新打开时只有配置路径、任务来源和运行中的随机标识都匹配，才重新接管；正常退出前再次核验。旧版无归属记录的服务、手动 LaunchAgent 和直接启动的 Gateway 都视为外部服务，不按端口或进程名停止。若无法停止自有服务，保留 App 和归属记录并提示重试，不假装退出成功。关闭窗口不等于退出，也不会注册开机自启。

生命周期测试仅使用专用测试身份和空配置，覆盖菜单栏入口、关闭/重开、SIGKILL 后接管、移动后的接管、启动中退出、旧记录及外部同名任务替换保护，测试不会连接真实消息渠道。图形测试需要已登录的 macOS 桌面会话。

开发仍使用上面的 Run 脚本，不必每次打独立包。独立 App 支持在启动进程环境中设置 `AGENT_GATEWAY_CONFIG`，固定端口从运行时配置读取。外部 Codex/DSH 工具仍需安装和登录；也会自动识别已安装的 Codex 桌面 App 内的命令；非标准安装位置可在配置中设置 `codexBinary` / `dshBinary` 绝对路径。旧的后台服务若已运行，App 会连接并保留它；要切换到内置服务，先退出旧 App，必要时卸载此前手动安装的后台服务。

当前包使用本机 ad-hoc 签名，已包含 Node 和依赖许可证；面向其他用户正式分发前还需 Developer ID 签名和公证。Node 版本及校验值在 `scripts/macos/package.mjs` 中固定，升级运行时后需重跑打包冒烟测试。

## 配置与迁移

默认配置：`~/.config/agent-imessage/config.json`。凭据保存在旁边的 `config.json.secrets.json`，Photon 管理授权保存在 `config.json.photon.json`，文件权限 `0600`，父目录必须为 `0700`。页面只返回“已配置”，不返回密钥。也支持通过环境变量提供密钥；launchd 不继承交互式 shell 的环境，后台服务优先使用 UI 保存的凭据或明确配置的服务环境。

```json
{
  "version": 1,
  "port": 8787,
  "stateDir": "/absolute/private/state",
  "codexBinary": "codex",
  "dshBinary": "dsh",
  "routes": [{
    "id": "my-project",
    "label": "My project",
    "backend": "cursor",
    "enabled": true,
    "cwd": "/absolute/project",
    "model": "composer-2.5",
    "effort": "default",
    "speed": "default",
    "projectId": "photon-project-id",
    "projectSecretEnv": "MY_PHOTON_SECRET",
    "senderPhoneNumber": "+15551234567",
    "assignedPhoneNumber": "+15557654321"
  }]
}
```

旧配置不会被启动过程自动覆盖：

1. **旧 Codex / Cursor bridge JSON**：可直接作为 `start` 参数使用。旧 `cursorBinary` 被忽略，未指定 backend 的路线仍为 Codex；旧 Cursor 路线现在需要 SDK API key。Codex 的 stateDir、会话和去重状态保留。旧 Cursor ACP 会话不能转换成 SDK 会话，因此使用新的隔离状态。
2. **Cursor SDK 原型 App**：显式导入全部项目和独立 secret 文件：

   ```sh
   agent-imessage import ~/.config/cursor-imessage-app/config.json ~/.config/agent-imessage/config.json
   ```

   源文件不变，目标已存在时拒绝覆盖。从标准旧目录导入时，还会迁移消息去重状态；只有经 SDK 本地元数据确认工作目录一致的会话才会恢复，否则开始新会话并保留旧记录。
3. **DSH 插件设置**：将原 settings JSON 与 Photon credential JSON 分别导出为私有文件，然后运行：

   ```sh
   agent-imessage import /private/dsh-settings.json /private/gateway/config.json /private/dsh-photon-credential.json
   ```

   支持旧扁平设置、`routes` 和 v1 单项目 / v2 多项目凭据。按 Photon 项目名称匹配，缺失或无效配置会报错，不丢弃路线。DSH 的持久化历史仍由 DSH 保存；旧插件的活动会话映射目前不自动迁移，Gateway 从新会话开始。

迁移后先停止/禁用旧消费者，再启动 Gateway。旧配置与旧持久化文件可以保留用于回退。仓库中的 `apps/cursor-imessage` 现在只是根 App 的启动入口；原浏览器入口编辑器扩展已移除。DSH 插件作为并行产品线保留在 [`apps/dsh-imessage`](./apps/dsh-imessage)，不再内嵌于本 App；旧 `packages/codex` 独立分发已移除。统一从仓库根目录构建和安装 **macOS App / Gateway**。

## 手机命令与共享工具

| 命令 | 行为 |
| --- | --- |
| 普通文本 | 在该路线当前会话启动任务；忙碌时拒绝新任务，不隐藏排队 |
| `/help`、`/status` | 帮助；backend、会话、忙碌状态、待处理交互 |
| `/new` | 下一个任务创建新会话 |
| `/sessions` | 列出 Gateway 在此路线记录的最近 100 个会话 |
| `/switch ID` | 恢复此路线已记录的会话，不能接管其他路线或未知 ID |
| `/stop`、`/cancel` | 请求取消，取消审批/提问，拒绝迟到的媒体与结果 |
| `/approve ID`、`/deny ID` | 仅批准/拒绝当前任务的一次操作 |
| `/answer ID {"question-id":"answer"}` | 回答当前任务的提问 |
| `//text` | 发送以 `/` 开头的普通任务 |

三个 backend 共用 `send_imessage_file`、`send_imessage_voice`、`ask_imessage_user`。文件与图片通过附件发送，音频通过原生语音消息发送。仅允许当前任务所属项目内的普通文件，最多 20 MiB；阻止路径穿越、符号链接逃逸和已取消任务继续发送。

目前入站仍是原项目已有的**文本消息**路径；入站图片、文件、语音识别未实现。出站文件/图片/原生语音已保留并接入三种 backend，不能把文字中的文件路径当成已发送附件。

## 架构与扩展

- `src/app/`：CLI、私有配置/迁移、Photon 账号、本地 Web API、launchd 安装器。
- `src/gateway/`：多路线生命周期、通用消息处理、会话状态、公共工具。
- `src/backends/types.ts`：`Backend` 接口，`initialize/openSession/startTurn/cancel/close`、类型化事件及交互请求。
- `src/backends/`：Cursor SDK、Codex App Server、DSH ACP 协议转换；SDK worker 隔离 Agent 的环境变量。
- `src/spectrum-runtime.ts` 与 Photon / media 基础模块：唯一的授权号码过滤、传输、重连、媒体验证实现。
- `scripts/macos/Native/`：唯一管理界面；`scripts/macos/Resources/`：原生图标资源。
- `apps/dsh-imessage/`：并行维护的 DSH Web 插件（Windows / Linux / macOS）。

新增 Claude Code 等 Agent 时，实现一个 `Backend` 并注册到 factory、配置 backend 枚举和 UI 选项即可；不需要重写 iMessage、Photon、审批提示、消息分块或文件验证。

SDK 自带的代理工具权限和 OS 沙箱仍是执行隔离的一部分；Gateway 的 cwd 和附件路径检查不是对任意 Agent 的完整 OS 安全沙箱。自定义 DSH 组合属于本地可信配置。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run audit:prod
npm run test:package
npm pack --dry-run --ignore-scripts
# 有真实账号时；临时项目 + 模拟收件端，不发真实 iMessage
CURSOR_API_KEY_FILE=/private/cursor.api-key npm run test:cursor:live
npm run test:codex:live
```

回归覆盖路由隔离、去重、取消竞态、审批超时/拒绝/归属、共享提问和媒体、迁移、私有目录、HTTP Host/Origin/CSRF 与并发配置修改。DSH 测试使用协议替身与真实 HTTP MCP 边界；真实模型调用需要配置可用的 DSH 模型账号。

完整手机验收还需要用授权手机号向对应 Photon 号码发任务，确认本地项目执行结果回到原对话。SDK 或 App Server 的模拟收件端测试不能替代这一项。

安全说明见 [SECURITY.md](SECURITY.md)。

在原生项目配置中，可点击“加载已有项目”，选择已授权 Photon 账户下的项目，再点击“使用所选项目 / 获取号码”。先填写自己的 iMessage 号码；如该号码尚未注册到项目，会创建对应的共享线路用户。凭证不会返回界面，点击保存后配置生效。也可以继续手动配置或创建新 Photon 项目。

模型字段支持下拉选择：点击“刷新模型列表”读取当前 backend 提供的模型；切换 backend 会清空旧模型并重新加载。Cursor 使用 SDK 模型目录，Codex 使用 App Server，DSH 使用 ACP 会话配置中的模型选项。保留默认模型和手动输入入口，加载失败不会删除已配置的模型。

项目保存只更新受影响的设置，保留其他项目及未保存草稿。名称、头像、计划不重启；模型参数下次任务生效；其他执行边界变更在忙碌时拒绝保存。共享 Cursor API Key 仅影响使用该密钥的 Cursor 项目。

项目卡片可选择审批权限，保存并应用后生效：Cursor 提供沙箱执行、沙箱加自动审核、完全访问（关闭沙箱且不请求审批）；Codex 默认沙箱内自动执行、额外权限人工审批，也可选择 Codex 自动审核或不请求审批（仍受工作区沙箱约束）；DSH 提供 iMessage 人工审批或拒绝额外权限。Cursor 自动审核依赖账户后端支持，不能转交给 `/approve`，也不是保证每个操作都自动放行。

Cursor 默认 `cursorSettings: "project"`，由 SDK 原生加载项目 `AGENTS.md` 和 `.cursor` 规则/配置；可在 UI 选择增加用户配置，或关闭本地规则加载。加载项目设置也会加载 SDK 支持的项目 hooks/MCP 等配置。规则属于模型指令，不是 OS 权限边界。

推理强度和速度按模型目录动态显示：Cursor 使用 SDK 返回的 `effort`/`fast` 参数，Codex 使用 `supportedReasoningEfforts` 和 `priority` 服务档，DSH 使用所选模型的 ACP `reasoning_effort` 选项。DSH 未提供独立速度控制，界面会禁用它；不支持的已保存参数会明确标记，避免静默丢弃。点击“刷新模型列表”获取当前能力，切换模型后参数回到默认。Fast 可能增加用量。

规则区对所有 backend 显示：Codex 原生读取用户和项目路径中的 AGENTS.md/AGENTS.override.md；DSH 原生读取 DSH_HOME 下的 AGENTS.md 及项目 AGENTS.md/CLAUDE.md 与 local 文件。Gateway 不额外拼接规则或覆盖其原生作用域。只有 Cursor 提供本应用可配置的 settings source 选择。规则是模型指令，并非确定性执行或安全边界。

Codex 的 `auto-review` 映射到 App Server `approvalPolicy: "on-request"` 与 `approvalsReviewer: "auto_review"`；默认和人工审批明确使用 `user` 审核，避免继承用户全局自动审核设置。所有这些模式均保留 workspace-write 沙箱。自动审核可能拒绝操作，并不表示全部允许。


## 聊天式监看与定时任务

原生项目页默认显示持久任务、执行状态和已保存结果，支持停止、审批、回答和重新发送。诊断开关显示最近活动；完整结果不依赖活动保留数量。公共网关计时覆盖接收、会话准备、提交、首个模型／工具活动、首段文本、完成与渠道发送。Cursor、Codex、DSH 共用此链路；具体活动只展示后端实际提供的事件。Cursor 和 DSH 支持回复片段预览，片段不会作为最终消息回传。工具步骤只显示固定类别，不记录内部思考文本或原始工具参数／结果。

超过 20 秒尚未完成时，原对话最多收到一次进度提示；等待审批时不另发提示。`/status` 可查询阶段、耗时和可用的运行 ID。中断、明确超时、连接错误、限流、认证失败分别报告；没有证据时不会把 aborted 当作超时，也不会自动重试可能产生副作用的任务。

每个入口最近 200 条活动保存在本机原有私有状态文件中（消息文本每条最多约 8 KB，片段保留尾部）。后台合并写入，正常退出会落盘；进程意外退出可能丢失最后约 1 秒活动。记录包含对话内容，不是永久审计日志。

在项目的「定时任务」页添加名称、任务正文、回复入口、五段 Cron 和 IANA 时区，例如 `0 9 * * 1-5` 配合 `Asia/Shanghai` 表示工作日 09:00。支持数字、`*`、逗号、范围、步长；周日为 0 或 7，日期和星期同时受限时按传统 Cron 的 OR 规则。每个项目最多 16 个任务，新任务默认停用，启用并保存后生效。常用时间可选择每天、工作日、每周及小时/分钟，Cron 放在高级选项；保存前可预览未来五次时间，保存后可立即试运行。

定时任务默认新建独立会话，可显式选择延续入口对话，沿用项目 Agent 和审批策略，最终结果主动回到该入口。调度器每 5 秒检查当前分钟，先持久化认领再执行；同一任务同一 UTC 分钟最多执行一次。项目忙碌、入口不可用时跳过并记下原因；不排队、不重试，不补跑关机／睡眠时错过的分钟。调度时钟和任务时间槽均先落盘，重启后不会重跑已认领的分钟。夏令时重复的本地分钟对应不同 UTC 分钟，会分别执行。

电脑需保持唤醒、Gateway 运行。关闭窗口可继续后台运行，退出 App 会停止其管理的服务。iMessage 使用配置的授权收件人；微信仅使用已绑定所有者最近一次有效入站消息的会话凭据，该凭据私有保存且不在 UI 回显。微信凭据过期可能拒绝主动发送，此时先给机器人重新发一条消息。渠道返回成功不等于用户已读。


## 任务可靠性与恢复

每次提交保存稳定任务 ID、入口消息 ID、会话和执行配置。执行状态与回传状态独立：发送异常标记为“未确认”（可能部分送达），不关闭执行后端；重发只发送本机保存的文本，不再次调用 Agent。工具发送的附件仍按原安全路径处理，不自动重发附件。重启时把未结束任务标记为中断，把发送中的结果标记为未确认，不自动补跑。

原生操作要求当前任务和请求 ID 匹配。请求超时、重复点击或手机已处理后，旧请求不能再次批准。完全访问需额外确认。定时任务跳过原因和调度中断记录保存在私有状态目录；睡眠、停止或断线不会触发自动补跑。

关闭窗口继续运行与登录启动是两个设置；在 App 设置中可打开系统登录项设置。CI 包含 macOS 原生编译、状态/API 契约与服务生命周期测试。

### 任务历史保留

每个入口常用状态保留最近最多 500 条任务、8 MiB 完整内容；执行或发送中的任务不裁剪。旧任务先按月写入私有 `stateDir/archives/`，成功后才从常用状态移出。归档不会自动删除，占用磁盘仍随历史增长，但不参与每次状态轮询与整份状态重写。原生「任务 → 归档历史」每页读取 25 条，可查看完整输入和结果、重发未确认送达的结果。请将归档目录与状态一起备份。

常规轮询只返回任务摘要（输入 400 字符、结果 800 字符），完整内容点击「查看完整任务」读取；搜索作用于当前加载的摘要。审批使用 10 位短 ID，原生界面展示请求内容与问题选项，并保留完整请求详情。

### Telegram 入口

在「消息渠道 → Telegram」选择「添加 Telegram Bot」，填写 Bot Token 和允许操作的 Telegram 用户数字 ID，点击「验证并添加 Bot」。Token 由 [@BotFather](https://t.me/BotFather) 创建机器人后取得；Bot ID 和用户名自动识别。用户 ID 必须是你自己的数字 ID，不能填写用户名或手机号。

三种渠道统一采用「消息渠道管理账号，Agent 页管理绑定」：

- 消息渠道：添加 Telegram Bot、扫码添加微信机器人、授权 Photon 并准备 iMessage 号码。显示当前绑定的 Agent，可跳转到 Agent 管理绑定；这里不选择 Agent。
- Agent → 项目配置 → 消息入口：点击「绑定 iMessage / 微信 / Telegram」，选择已准备的账号并保存。iMessage 允许联系的手机号也在此设置。其他 Agent 已占用的账号显示归属并禁选。
- 解绑：在 Agent 页点击「解绑此入口」并保存，账号和凭据仍保留在消息渠道，之后可绑定其他 Agent。仍被定时任务引用的入口须先调整计划。停用项目仍占用绑定，解绑全部入口后项目停用。

绑定 Telegram 后，使用允许的账号向机器人私聊发送 `/start`，再发送任务。

- 通过 [Telegram Bot API](https://core.telegram.org/bots/api#getupdates) 长轮询收消息，无需公网端口；运行网关的机器必须能访问 `api.telegram.org`。
- 一个机器人只能绑定一个入口（包括停用的项目），不能同时运行其他轮询程序或 Webhook。冲突时先停用另一消费者；已有 Webhook 需要自行移除。
- 仅接受指定用户的私聊文字，群聊、其他用户和机器人消息不会执行。图片、语音、文件及其说明文字不会作为任务执行，会提示改发文字。
- 支持任务回复、长文本分段、输入状态、文件回传、独立会话和现有审批命令。音频按文件发送；暂不解析入站附件或发送原生语音。
- 定时任务选择对应 Telegram 入口即可；用户必须先与机器人开始会话，机器人才能发送消息。
- Token 保存在配置文件旁的 `config.json.secrets.json`（权限 `0600`），不会返回到管理状态接口；再次保存时留空可保留。更换允许操作的用户或机器人会隔离原会话与去重状态。

手动配置时，在项目的 `channels` 中增加以下入口，并在私有凭据文件的 `telegram` 对象中以 Bot ID 为键保存 Token（保留原有 `photon` 等字段）：

```json
{"id":"telegram","kind":"telegram","botId":"123456789","ownerUserId":"987654321"}
```

```json
{"photon":{},"telegram":{"123456789":"123456789:YOUR_BOT_TOKEN"}}
```

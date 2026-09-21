# dsh-imessage：让 DSH 真正在 iMessage 里工作

**中文** | [English](./README.en.md)

这个目录是仓库里与 macOS App **并行维护** 的 DSH 插件产品线。它跑在 DeepSeek Harness 的 Web 配置里，支持 **Windows / Linux / macOS**。根目录的 Agent iMessage 是独立的 macOS 原生 App，两者配置和进程互相独立。

这个 fork 把 DeepSeek Harness（DSH）接入 iMessage。除了通过短信式对话远程使用 DSH，它还能让 DSH 在当前 iMessage 会话里直接发回**图片、任意文件和原生语音消息**。

> 不只是把最终答案转成文字：你可以让 DSH 把工作区里的图表、文档、压缩包或音频直接发到手机上。

## 本 Fork 新增的能力

这些能力是相对上游 [`photon-hq/dsh-imessage`](https://github.com/photon-hq/dsh-imessage) 的主要增强，也是本项目当前最值得关注的部分。

| 能力 | 效果 |
|---|---|
| **发送图片** | DSH 可以把工作区里的 PNG、JPEG、GIF、WebP、HEIC 等图片直接发到当前 iMessage 会话，并由“信息”以内联图片显示。 |
| **发送任意文件** | PDF、文本、CSV、JSON、ZIP 以及其他普通文件都可以作为 iMessage 附件发送，不再局限于图片。 |
| **发送原生语音** | MP3、M4A、WAV、AIFF、AAC、CAF、OGG 等音频会作为 iMessage 原生语音气泡发送，而不是只返回一个本地路径。 |
| **每条路由独立工作区** | 每个 iMessage 号码可以绑定一个绝对路径，DSH 在对应项目目录中工作和查找待发送文件。 |
| **每条路由独立 Photon 项目** | 可自定义 Photon 项目名，避免多台机器或多个项目共享同一个云项目和托管号码。 |
| **一台电脑配置多条 iMessage 路由** | 每条路由拥有自己的 Photon 项目、工作区、托管号码、监听器和当前 DSH 会话。 |
| **更稳健的 Photon 配置** | 安全跟随同源 API 重定向；项目列表失败时可回退到创建指定项目，减少不透明的初始化失败。 |

旧版单路由配置会自动迁移为一条默认路由。

### 直接从 iMessage 使用媒体能力

你可以自然地对 DSH 说：

- “把 `reports/allocation.png` 发给我。”
- “把刚生成的 PDF 和原始 CSV 都发过来。”
- “把这段音频作为语音消息发给我。”

在由 iMessage 发起的当前回合中，模型可以调用：

- `send_imessage_file`：发送图片或任意普通文件；
- `send_imessage_voice`：发送 iMessage 原生语音消息。

媒体文件必须位于该路由的工作区内，默认最大为 20 MiB。插件会拒绝越过工作区的路径、符号链接逃逸、目录和超限文件。媒体只能发回触发当前回合的那条 iMessage 私聊，浏览器发起的回合不能意外向手机发送附件。

iMessage 原生语音默认可能显示“2 分钟后过期”。这是 Apple 的语音消息保留策略，不是发送失败；可以在消息下方点“保留”，或在 iPhone 的“设置 → App → 信息 → 音频信息 → 过期”中选择“永不”。

### 当前媒体边界

- 当前支持 **DSH → iMessage** 的出站图片、文件和语音。
- 当前入站仍是文本：你从 iPhone 发给 DSH 的图片、文件和语音不会被处理。
- 插件负责发送现有文件，本身不负责生成图片或把文字合成为语音；DSH 可以先用其他工具生成文件，再调用发送工具。
- 最终文字回答仍会被转换为适合 iMessage 的纯文本；Markdown 标记不会原样发送。

## 安装这个 Fork

npm 上未带仓库地址的 `dsh-imessage` 指向上游正式包，不保证包含本 fork 的增强。要使用这里的图片、文件、语音和多路由能力，请从本仓库的插件目录打包安装。

macOS / Linux：

```sh
git clone https://github.com/ShoWin2333/dsh-imessage.git
cd dsh-imessage/apps/dsh-imessage
npm ci --legacy-peer-deps
npm run build
npm pack
dsh plugin --profile web remove dsh-imessage
dsh plugin --profile web add ./dsh-imessage-*.tgz
dsh web
```

Windows（PowerShell；无需 WSL）：

先安装 Node.js **22.19+（22 系列）或 24+**，确认 `node -v` 与 `npm -v` 可用，然后：

```powershell
git clone https://github.com/ShoWin2333/dsh-imessage.git
cd dsh-imessage\apps\dsh-imessage
npm ci --legacy-peer-deps
npm run build
npm pack
npx --yes @deepseek-ai/dsh plugin --profile web remove dsh-imessage
npx --yes @deepseek-ai/dsh plugin --profile web add (Get-ChildItem .\dsh-imessage-*.tgz | Select-Object -First 1).FullName
npx --yes @deepseek-ai/dsh web
```

如果已经安装过上游包或同版本的旧构建，上面的 `remove` 会清掉缓存后再装本 fork。PowerShell 不会展开 `*.tgz` 通配符，必须传入实际文件路径。工作区请填 Windows 绝对路径，例如 `D:\work\app`；从资源管理器「复制路径」带上的引号会被自动去掉。

如果 DSH 由 launchd、计划任务或其他常驻服务启动，请在安装后重启对应服务。

### 兼容目标

- DeepSeek Harness `0.1.5-rc.1`（当前官方 latest / next）
- Spectrum `12.7.x`（当前锁定为 `12.7.0`）
- Node.js `22.19+` 或 `24+`

## 配置路由

打开 **Settings → iMessage**：

1. 点击 **Authorize**，完成 Photon 设备授权。
2. 新增或编辑路由，为它设置本地工作区、Photon 项目名和发信号码。
3. 工作区留空时使用 `dsh web` 的进程目录；Photon 项目名留空时使用 `dsh`。Windows 使用盘符路径（`D:\work\app`）或 UNC（`\\server\share\repo`），macOS / Linux 使用 `/absolute/path`。
4. 保存你会用来给托管号码发消息的 E.164 手机号。同一个个人号码可以复用于多条路由。
5. 复制该路由分配到的托管 iMessage 号码，并从已配置的个人号码给它发消息。

每条路由应使用不同的 Photon 项目名。Photon 会为每个项目分配独立托管号码，而本地插件会为每条路由维护独立监听器和活动会话。

## 继承自上游的能力

下面这些基础能力来自上游插件，本 fork 在其上继续扩展：

- 通过 Photon 托管号码收取 iMessage，并把文本消息排入 DSH；
- 在 DSH 设置页完成 Photon 设备授权、号码配置和运行状态查看；
- 把 DSH 的最终回答发回同一条 iMessage 私聊；
- 创建、列出和切换同工作区的根会话；
- 通过 iMessage 处理 DSH 的批准请求和交互式问题；
- 持久化消息去重、监听器重连、长文本 Unicode 安全分段；
- 对凭据、路由和当前回合执行 fail-closed 隔离。

## iMessage 命令

普通文字会作为 DSH 提示排队。如果提示本身需要以 `/` 开头，请写成 `//`，例如 `//review this route`。

| 命令 | 行为 |
|---|---|
| `/help` | 显示命令帮助。 |
| `/new` | 创建并选中一个新的根会话。 |
| `/sessions [page]` | 列出同工作区的根会话，默认每页五条。 |
| `/switch <index\|session-id>` | 按列表序号、完整 ID 或唯一 ID 前缀切换会话。 |
| `/status` | 显示活动会话和当前状态。 |
| `/stop` 或 `/cancel` | 取消正在运行的回合，并使仍在 iMessage FIFO 中等待的提示失效。 |
| `/approve <request-id>` | 批准与当前 iMessage 回合关联的请求。 |
| `/deny <request-id>` | 拒绝关联的请求。 |
| `/answer <request-id> <option-or-text>` | 回答关联的问题；逗号可选择多个编号选项。 |

当 iMessage 提示正在排队/运行或仍有待处理的人机交互时，`/new` 和 `/switch` 会拒绝执行；请先发送 `/stop`。

## 路由与隐私边界

入站消息只有同时满足以下条件才会被接收：

- 平台为 iMessage，方向为入站；
- 会话是私聊；
- 发件人等于该路由配置的 E.164 号码；
- 专用连接的收件号码与路由托管号码一致，或消息来自 Photon 已按项目隔离的 shared 路由；
- 当供应商提供 service 字段时，其值必须是 iMessage；
- 入站内容为文本。

未授权流量会被静默忽略。插件不记录消息正文、原始手机号、设备码、访问令牌或项目密钥。主机只持久化非敏感路由设置、一个不透明 Photon 凭据对象、每条路由的活动会话 ID，以及一个有界的入站消息去重窗口。

每个 iMessage 提示都按精确的 DSH `UserMessage.id` 关联。只有 DSH 真正 claim 该消息后，当前回合才拥有向这条 iMessage 会话发送文字、附件、语音、批准请求或问题的权限。同一 Agent 中由浏览器发起的回合仍只留在浏览器。

只有最终回答会发送到 iMessage；中间推理、工具活动和部分输出留在 DSH。长回答会尽量在段落、行或单词边界分段，并且不会拆开 Unicode 字素簇。

## Photon 资源行为

插件通过 HTTPS 实现 Photon CLI 兼容的 RFC 8628 设备流程，不启动 Photon CLI，也不读取 CLI 凭据文件。项目和用户配置遵循以下原则：

- 精确复用可访问且同名的 Photon 项目；没有匹配项时才创建 US/iMessage 项目；
- 多个同名项目或用户会报告公开 ID，插件不会任意选择；
- 新号码和 Spectrum 连接准备成功后才替换当前路由；准备失败时旧监听器继续工作；
- 断开连接只清理本地设置和凭据，不删除 Photon 云端项目、用户或托管号码；
- 管理令牌过期后，现有项目密钥仍可继续路由，但项目和用户变更需要重新授权。

## 主机配置

以下选项只在主机配置中提供，不显示在设置页：

| 选项 | 默认值 |
|---|---:|
| `photonApiOrigin` | `https://app.photon.codes` |
| `interactionTimeoutMs` | `600000`（10 分钟） |
| `maxOutboundChars` | `3500` 个字素 |
| `maxOutboundMediaBytes` | `20971520`（20 MiB） |
| `sessionsPerPage` | `5` |
| `dedupeEntries` | `1024` |
| `reconnectMinMs` | `1000` |
| `reconnectMaxMs` | `60000` |

可以在 web profile 的 `cordis.patch.yml` 中覆盖 bundle 行。DSH patch 会替换整行，因此必须保留 `id` 和 `name`：

```yaml
- id: dsh-imessage
  name: dsh-imessage
  config:
    interactionTimeoutMs: 900000
    maxOutboundChars: 3000
    maxOutboundMediaBytes: 31457280
```

除测试使用的 loopback HTTP 外，非 HTTPS Photon API 地址会被拒绝。

## 限制

- 每个插件实例使用一个 Photon 账户，但可以配置多条 iMessage 路由。
- 入站当前只接受文本私聊；入站附件、语音、reaction、群聊、SMS 和 RCS 会被忽略。
- 出站支持最终文字回答、普通文件/图片附件和原生语音；不提供内置图片生成或文字转语音。
- 同一个人手机号可以复用于多条路由，但每条路由仍需要独立托管号码。
- `/sessions` 和 `/switch` 只显示工作区完全匹配的根会话，不包含 subagent。
- 不会自动清理 Photon 云端资源。

## 故障排查

| 错误或现象 | 处理方式 |
|---|---|
| 图片或语音工具没有被调用 | 确认当前提示是从 iMessage 发起，而不是从 Web 会话发起。 |
| 文件在工作区外 | 把文件复制到该路由配置的工作区内再发送。 |
| 语音显示 `00:00` | 确认使用包含本 fork 最新语音容器修复的构建，并在安装同版本包前先 remove 旧包。 |
| 语音显示“2 分钟后过期” | 点“保留”，或把 iPhone 的音频信息过期设置改为“永不”。 |
| `invalid-phone` | 使用 `+`、非零国家码数字和最多 15 位总数字，不要包含空格或标点。 |
| `auth-expired` / `auth-denied` | 重新开始 Photon 授权并在有效期内完成。 |
| `authorization-required` | 重新授权 Photon；如果项目密钥仍有效，现有路由可能继续运行。 |
| `project-ambiguous` | 重命名重复项目，只保留一个精确匹配的名称。 |
| `shared-line-unavailable` | 请求 Photon shared 容量或配置 dedicated allocation。 |
| `runtime-failed` | 使用 **Retry listener**；若重复失败，检查 Photon 项目的 iMessage 平台和托管号码。 |

## 开发与验证

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm pack --dry-run
# 如果本机有 0.1.5-rc.1 DSH：
DSH_BIN=/path/to/dsh npm run test:profile
```

测试覆盖设备授权退避/取消、凭据脱敏、Photon 项目与用户幂等性、入站过滤、消息去重、监听器重连、Unicode 分段、精确回合归属、批准/问题 fail-closed、会话生命周期、媒体路径隔离、文件大小限制、附件/语音适配和设置 UI。

仓库包含 Node 22.19 和 Node 24 的 CI workflow，以及打包后安装到一次性 DSH web profile 的 smoke test。Fork 仓库是否实际执行 Actions 取决于该仓库的 GitHub Actions 设置。

## 发布说明

这个 fork 仍使用与上游相同的 npm 包名 `dsh-imessage`。仓库中继承的发布 workflow 和 npm Trusted Publisher 原本绑定 `photon-hq/dsh-imessage`，不会自动赋予 fork 发布上游 npm 包的权限。除非为 fork 单独配置包名和发布凭据，否则请使用本地 tarball 或 fork 自己的 GitHub Release 分发。

## 开发背景与致谢

这是我在开源开发起步阶段持续学习和维护的一个项目。感谢上游 [photon-hq/dsh-imessage](https://github.com/photon-hq/dsh-imessage) 提供的基础，也感谢 Codex 帮助我理解已有代码、探索实现方式，把原本难以独立完成的想法逐步变成可用的改进。

我还没有成熟的社区或推广经验，希望从自己的实际需求出发，把这些改进公开分享，并在持续维护中成长。

## 上游与参考资料

- [上游 dsh-imessage](https://github.com/photon-hq/dsh-imessage)
- [本 fork](https://github.com/ShoWin2333/dsh-imessage)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Photon CLI authentication](https://photon.codes/docs/cli/authentication)
- [Spectrum TypeScript getting started](https://photon.codes/docs/spectrum-ts/getting-started)
- [Spectrum iMessage routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing)

# Codex 接入（预览版）

Agent iMessage 在同一仓库维护 DSH 插件和 Codex 独立桥接程序。Codex 版本通过官方 App Server 操作本机项目，不要求安装 DSH，不连接 Codex 云端，也不承诺接管桌面端已有任务。

## 安装

需要 Node.js 22.19+（22.x）或 24+，以及已通过 `codex login` 登录的 Codex CLI。当前接口验证版本为 `0.154.0-alpha.6.2`；媒体工具使用实验性动态工具接口。

在仓库根目录执行：

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run build:codex
npm pack ./packages/codex
npm install --global ./showin2333-agent-imessage-0.1.0.tgz
agent-imessage doctor
```

构建环境包含 DSH 开发依赖，但生成的 Codex 安装包不依赖 DSH。包尚未发布到 npm。

## Codex CLI 兼容设置

部分单独安装的 alpha CLI 缺少配套 `codex-code-mode-host`，可能出现文字可用但工具调用失败。`doctor` 只检查连接和账号，不验证工具执行。请使用完整且版本匹配的 Codex 安装，将配置中的 `codexBinary` 指向其可执行文件；本版本关闭该宿主也不能执行动态工具。无需修改全局配置。

## 配置 Photon 路由

1. 为 Codex 准备独立 Photon 项目，启用 iMessage，配置自己的发送号码并取得托管收信号码。不要让 DSH 与 Codex 同时监听同一个 Photon 项目。
2. 复制 [`config.example.json`](../packages/codex/config.example.json)，填写工作区绝对路径、状态目录、项目 ID 和号码。
3. 将 Photon 项目密钥放入配置中 `projectSecretEnv` 指定的本机环境变量。不要将密钥写进仓库或发进聊天。
4. 执行 `agent-imessage start /absolute/path/config.json`，保持电脑和程序运行，然后从指定号码向托管号码发消息。

预览版没有 Photon 授权和创建项目的界面，需要先在 Photon 完成配置。多个 Codex 路由分别填写不同项目；现有 DSH 路由仍在 DSH 的设置页面管理，当前没有统一设置界面。

## 使用

直接发文字启动任务。`/new` 在空闲时切换到新会话，`/status` 查看状态，`/stop` 中止任务。审批时按提示回复 `/approve ID` 或 `/deny ID`；多项问题用 `/answer ID {"问题ID":"回答"}` 回复。忙碌时的新任务不会排队，需要等待完成后重新发送。

可以要求 Codex 把工作区内已有图片、文件或音频发回当前对话。文件上限为 20 MiB，不接受工作区外的文件和符号链接逃逸。手机发来的图片、文件和语音暂不处理。

## 验收与限制

- 使用独立 Codex 进程、工作区绑定和精确回合 ID 隔离路由；只回传最终答案。
- 默认使用 `workspace-write` 沙箱和 `untrusted` 审批策略，同时遵守本机 Codex 配置；不代表所有操作都必须审批。
- 审批十分钟过期；不支持的授权、无法完整显示的审批和秘密输入问题会被拒绝。断线会中止当前任务并取消待处理审批。
- 状态目录权限必须为 0700，状态文件为 0600。最近 1,024 条入站消息做持久化去重，崩溃后不自动重试不确定任务。不是严格的一次性执行或保证送达。
- 正常退出会清理路由锁；异常退出后，先确认旧进程已停止，再移除对应 `.lock` 目录。不同状态目录间无法检测重复监听。
- 本地工作区需要可信。媒体检查不保证抵御其他本机进程同时修改路径的竞争条件。
- Photon 服务的费用、可用性与 Codex 独立。程序不打印密钥，实际消息和附件仍经 Photon/iMessage 传输。
- PR 阶段验证自动测试、独立打包和本机 Codex 接口；真实手机收发按维护者计划在独立 Photon 路由配置后验收。

完整说明见 [Codex package README](../packages/codex/README.md)。

如需使用 Cursor 账户，请参阅 [Cursor 适配指南](cursor.zh-CN.md)。同一独立桥接安装包通过每条路由的 `backend` 选择 Codex 或 Cursor；省略时仍为 Codex。

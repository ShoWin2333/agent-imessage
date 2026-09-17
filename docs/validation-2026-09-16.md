# 2026-09-16 架构升级验证记录

## 已通过

- `npm run typecheck`、`npm run build`。
- `npm test`：18 个测试文件、85 项测试全部通过。HTTP/MCP 测试需要允许绑定本地 loopback 端口。
- `npm run audit:prod`：高危阈值通过；生产依赖仍有 13 项 moderate 告警，来自 Photon/OpenTelemetry 依赖链。不使用会降级 Spectrum 主版本的 `audit fix --force`。
- `npm pack --dry-run --ignore-scripts`：产物包含独立 CLI、后端 worker、Web UI 和声明文件。
- `node scripts/package-smoke.mjs`：把真实 tarball 解包到临时目录，安装生产依赖；无开发依赖、无 DSH 宿主依赖，SDK 与 Gateway 公共入口成功导入，本地 HTTP UI 和状态接口成功响应。
- 实际浏览器：打开独立 UI、新建项目、填写参数、关闭自动启动、保存并刷新，确认配置和停止状态持久化。
- 真实 Cursor SDK：私有临时项目内读取 `hello.txt`，调用共享文件发送工具，返回预期标记。收件端为模拟实现。
- 真实 Codex App Server：临时项目、真实会话与任务、共享动态文件工具、最终回复。收件端为模拟实现。
- 真实 DSH CLI `0.1.5-rc.1`：无 DSH Web 的 ACP 握手、会话创建、Gateway HTTP MCP 共享工具发现。未执行真实 DSH 模型任务。
- 本机旧 Cursor SDK App 配置、凭据、消息去重和经 SDK 元数据验证的工作目录内会话已迁移；源文件保留。
- 新 launchd 服务 `app.agent-imessage.gateway` 已安装。旧 `com.alice.cursor-imessage-app` 服务定义保留但禁用，避免登录后重复消费 Photon。
- 真实 Photon 路线连接成功，状态 `listening`；UI 为 `http://127.0.0.1:8787`。

## 尚未通过的验收

完整的“授权手机号 → iMessage → Photon → Gateway → 本地 Agent → 手机回复”尚未确认。

本机 Messages 发送的验收消息已到达 Photon，但 Photon 明确回复：当前发信身份是邮箱，共享号码只支持手机号，无法将其路由给 Agent。Gateway 的授权号码过滤未放宽，也没有更改用户 Messages 发信身份。

需要从配置中的授权手机号发送：

```text
Gateway acceptance test: read the first line of README in the current project and reply with GATEWAY_OK followed by that line. Do not modify any files.
```

随后确认手机收到回复，并核对 Gateway 的最近任务结果。模型直连和模拟收件端测试不替代此项。

## 明确能力边界

- 入站图片/文件/语音识别尚未实现；原有文本入站、出站文件/图片/原生语音路径保留。
- Cursor SDK 的通用原生工具审批回调不可用；始终启用沙箱，不自动放行。共享提问工具可用。
- DSH 旧插件活动会话映射不自动导入，历史会话仍保存在 DSH 中。
- 服务安装器目前针对 macOS；其他系统需自行配置进程管理器。

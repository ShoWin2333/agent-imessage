# Cursor backend

Cursor 已改为官方 `@cursor/sdk@1.0.31` 直连本地项目，不再使用 Cursor CLI 或 ACP。

统一安装、配置、迁移、后台常驻和能力边界见 [根目录 README](../README.md)。原 `apps/cursor-imessage` 的执行代码已合并，原编辑器扩展现在仅打开统一 Web UI。

旧 bridge 的 `cursorBinary` 不再生效；请配置 Cursor API key。Cursor SDK 原型的多路线配置与 secret 可以使用 `agent-imessage import SOURCE DEST` 迁移。旧 ACP 会话与 SDK 会话不同，不会混用。SDK 沙箱默认开启，可在本地项目审批设置中明确选择完全访问，默认加载项目 AGENTS.md/.cursor 规则；原生工具审批由 SDK 自身决定；共享媒体与 `ask_imessage_user` 在 Gateway 统一处理。

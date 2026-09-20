# Codex backend

Codex App Server 已纳入独立 Agent iMessage Gateway，与 Cursor SDK、DSH backend 平级。

在根目录执行 `npm run build` 和 `npm start`，在原生 App 选择 `codex`。提前在本机安装 CLI 并执行 `codex login`；不需要 Codex Desktop。旧配置可以直接传给 `agent-imessage start CONFIG`，原 stateDir 与会话保持兼容。

原 `packages/codex` 独立包与构建命令已移除。安装、共享工具、审批、迁移和后台运行详见 [README](../README.md)。

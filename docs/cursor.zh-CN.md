# Cursor 接入 iMessage（预览版）

Cursor 和 Codex 使用同一个 `agent-imessage` 安装包，在路由中设置 `"backend": "cursor"` 即可选择 Cursor。省略 `backend` 时仍使用 Codex。DSH 插件保持独立。

## 安装与启动

1. 按 [Cursor 官方指南](https://cursor.com/docs/cli/installation)安装支持 `agent acp` 的 Cursor CLI，在本机执行 `agent login` 完成登录。仅安装 Cursor 编辑器不等于安装了 CLI。
2. 在本仓库构建并安装桥接：

   ```sh
   npm ci --legacy-peer-deps --ignore-scripts
   npm run build:codex
   npm install -g ./packages/codex
   agent-imessage doctor cursor
   ```

   安装目录和构建命令保留历史名称，但构建产物已包含两个后端。包尚未发布到 npm。
3. 复制 `packages/codex/config.cursor.example.json` 到仓库外。填写项目目录、专用 Photon 项目、号码和私有状态目录。若 `agent` 不在 PATH 中，将 `cursorBinary` 设置为完整路径；诊断时可执行 `agent-imessage doctor cursor /absolute/path/to/agent`。
4. 在本机环境设置配置中 `projectSecretEnv` 指定的 Photon 密钥，然后执行：

   ```sh
   agent-imessage start /absolute/path/to/config.json
   ```

密钥不要放进配置或提交到 Git。每条 Photon 路由只能有一个接收端，不能让 DSH、Codex、Cursor 同时消费同一条路由。多后端可以放在同一个配置文件中，但必须使用不同的路由 ID 和 Photon 项目。

## 手机使用

直接发送文字开始或继续 Cursor 会话。`/status` 查看后端及运行状态；`/new` 在空闲时新开会话；`/stop` 取消当前任务。忙碌时的新任务不会排队。仅发送累积后的回答文字，不转发思考内容；ACP 没有 Codex 的 final-answer 标记，返回文字可能包含面向用户的进度描述。

工具或计划需要审批时，回复 `/approve ID` 或 `/deny ID`。工具审批只接受单次授权，不提供永久授权；超时、断线、无法完整展示或缺少单次选项时取消审批。Cursor 单选问题可回复 `/answer ID {"问题ID":"选项ID"}`。多选及未知交互暂不支持，会取消或拒绝，不自动放行。

`cursorMode` 可设为 `agent`（默认）、`plan` 或 `ask`，需当前 CLI 支持。模式和模型是 Cursor 的执行配置，不代表免费的聊天额度。可用可选 `model` 指定 Cursor 模型。修改后端或 Cursor 模式会使用独立会话状态，避免恢复到另一种后端或模式的会话；原 Codex 状态兼容保留。改配置后重启桥接。

## 能力边界

- 使用 Cursor CLI 的登录和用量，不调用 Codex App Server，也不消耗 OpenAI Work/Codex 的额度。Cursor 实际计费以账户、模型和套餐为准。
- 使用 Cursor 自己的权限、规则、Hooks 和 MCP 设置；Codex 的沙箱与审批策略不会移植过来。桥接没有使用 `--force`，也没有自动批准权限。只会转发 Cursor 实际发出的审批；Cursor 本身允许的操作不一定需要手机审批。
- 会话由本桥接创建；不承诺接管编辑器里已有的会话。恢复需要 CLI 支持 ACP `session/load`。
- 本版支持文本、审批、单选问题、恢复和取消。暂不支持 Cursor 主动发送文件/语音、入站附件、图像生成通知和团队级 MCP。不能把自然语言里的本地路径当成已发送附件。
- CLI 完成或取消前，路由保持忙碌；取消后 10 秒仍未结束会关闭进程并停止桥接。单次任务最多等待 30 分钟；进程关闭后必须重新启动桥接。不会自动重放结果不明的任务。
- `doctor` 只检查协议握手与认证；不证明真实模型调用或手机收发可用。真实 Cursor 账号和专用 Photon 手机路由仍需验收。

协议依据：[Cursor ACP 官方文档](https://cursor.com/docs/cli/acp)。

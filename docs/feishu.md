# 飞书单聊通道

本分支新增 `kind: feishu`，复用现有 DSH 会话、模型、权限预设、共享审批、问答、取消及回复日志。不修改 DSH 本体。实现使用官方 `@larksuiteoapi/node-sdk` 1.76.0，按需加载，固定访问飞书国内平台；不需要公网回调服务。

## 最少接入步骤

1. 在飞书开放平台准备一个**企业自建应用**，开启机器人能力，将测试用户纳入可用范围。开通应用身份权限 `im:message.p2p_msg:readonly`（接收用户发给机器人的单聊消息）及 `im:message:send_as_bot`（以应用身份发送消息）；如需图片/文件发送，再开通 `im:resource`。在事件与回调中选择**使用长连接接收事件**，订阅 `im.message.receive_v1`；使应用版本及所申请权限对测试租户生效。若控制台要求先建立连接，先完成下面配置、启动测试绑定，再保存事件订阅。
2. 确认 App ID、租户 `tenant_key`、允许用户在**该应用**下的 `open_id` 和机器人与该用户的单聊 `chat_id`。可从平台中已验证的接收消息事件确认这些 ID。没有单聊 ID 时，用户可在官方 API 调试台用 `receive_id_type=open_id` 给已确认的自己发送一条测试消息，从返回值读取 `data.chat_id`。不要把其他应用的 Open ID、群聊 ID 或企业编号当成这些字段。
3. 将 App Secret 配置在 **DSH 的凭据服务**中。插件的 `credentialRef` 只填写该凭据的引用名，不填写 Secret、token、JSON 或 Webhook URL。无需向开发者发送 Secret。选取已有工作目录及权限预设，保存以下绑定；初始保持停用。
4. 在独立测试配置中启用绑定，等待“已连接”，然后在指定单聊发送 `/status`、普通文字任务、`/cancel`，验证回复及会话连续性。分别验证一次批准、拒绝、过期及桌面先回答的审批；如开通资源权限，再验证一张图片和一个文件。停止/重启后重放同一合成事件的离线测试已覆盖，真实断线重连和租户权限仍需联调。

```yaml
- id: owner-feishu
  enabled: false
  cwd: /absolute/existing/workspace
  permissionPreset: workspace-write
  credentialRef: FEISHU_APP_SECRET
  channel:
    id: feishu
    kind: feishu
    appId: cli_1234567890abcdef # 示例，替换为真实 App ID
    tenantKey: verified_tenant_key
    ownerUserId: ou_verified_owner
    chatId: oc_verified_private_chat
```

同一应用只能配置一个消费者；不要在多个进程、机器或 DSH 配置中同时运行这个 App ID 的长连接。一个应用有多条连接时，飞书可能把事件分发给其中一条，插件无法协调另一个进程。轮换 Secret 后由宿主重新加载绑定。改变应用、租户、用户、单聊、工作目录或权限预设会进入独立的会话分区；只轮换凭据引用保留原分区。

## 行为与边界

- 入站必须同时匹配应用、事件租户、发送人租户、用户 Open ID、固定 Chat ID、`sender_type=user`、`chat_type=p2p`、`message_type=text`。其他用户、外部租户、群聊、机器人及图片/文件/语音/富文本消息不执行任务。无法确认身份时直接拒绝路由。
- 出站始终用 `receive_id_type=open_id` 发给配置的 Owner；入站内容无法指定收件人。图片上限 10 MiB；文件上限沿用插件 20 MiB。语音使用文件回退，不转录或合成音频。飞书没有本实现所需的输入中状态，`responding` 直接执行回调。
- `/status`、`/help`、`/cancel`、`/stop`、`/approve <token>`、`/deny <token>`、`/answer <token> ...` 使用原生桥接。审批显示完整原因与一次性令牌，收到且确认送达后才能回答；断线、取消、过期、卸载或重启使令牌失效。与桌面共享一次审批决定，最终状态另发文字。没有卡片按钮或新增审批权限。
- 官方 SDK 管理 token、长连接鉴权、心跳和重连。只有实际就绪回调才显示“已连接”；启动握手 60 秒未成功则失败并关闭，需显式停止/启动或由宿主重载。断线立即停止新的发送/审批，SDK 恢复后继续接收。停止会中止 HTTP 请求、关闭连接和定时器，旧回调不能重新激活绑定。
- 同一消息 ID 的并发事件共享一次入站处理。串行队列最多 32 条，满载/处理失败/检查点保存失败会向 SDK 返回失败，让飞书按其重试规则重投；只在 DSH 持久化接收后保存 transport 去重记录。保存最近 1024 条消息 ID，跨重启生效；DSH 现有收据提供额外的执行和回复去重。有限窗口、平台重试次数、跨进程消费者及外部发送的不确定性意味着不保证端到端恰好一次。
- 文本按 UTF-8 字节分段，保留字素及全部内容。发送只对明确的 HTTP 429 / API 限流拒绝做最多两次退避重试，每个发送请求保留同一 `uuid`。其他业务失败、超时、连接中断、5xx 及附件上传失败不自动重试；桥接层仍将不确定投递标记为 `uncertain`，不重新执行任务。
- SDK 日志静默，公开错误为固定文字；HTTP 请求不跟随重定向，每次有 15 秒超时及绑定/调用取消信号。没有读取真实凭据或改动生产配置的测试。

## 离线验证

`npm run check` 包含构建、Host/Client 类型检查、全部测试、产物设置面板渲染及打包清单检查。新增测试使用合成身份、模拟官方 HTTP/长连接和临时存储，覆盖身份拒绝、重试/去重、会话恢复、审批与连接生命周期，不发送真实飞书消息。

参考官方接口：[Node SDK](https://github.com/larksuite/node-sdk)、[长连接](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)、[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)、[发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)、[上传图片](https://open.feishu.cn/document/server-docs/im-v1/image/create)、[上传文件](https://open.feishu.cn/document/server-docs/im-v1/file/create)、[自建机器人权限](https://open.feishu.cn/document/develop-a-card-interactive-bot/faqs)。

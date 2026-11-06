# QQ Bot 官方参考重做

本次从不含 QQ 的 `4f7f603`（已移除 Discord、飞书）建立独立分支 `qqbot-official-rebuild`，没有复制上一版 QQ 的代码、补丁或测试。没有修改 DSH 本体；后续应用户要求，以本地包安装到 Mac mini 的现有 profile。未发布 npm，也未由本次验证发送真实 QQ 消息。

官方来源：[腾讯 QQ Bot 接入文档](https://bot.qq.com/wiki/agent-qqbot/)、[tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)，本次核对版本 `0.5.5`，源码 commit `14d5eef97274e47f34f91dcaa833be994ba2a770`。使用官方 `@tencent-connect/qqbot-nodejs@1.0.5` 和 `@tencent-connect/qqbot-connector@1.2.0`。`src/channels/qqbot-official` 的二维码、Markdown 切分和回复窗口模块来自该源码；图片理解沿用其 `saveImage → image block → llm.stream → BlockAssembler` 流程。

## 功能对照

| 官方能力 | 本次实现与本项目约束 |
| --- | --- |
| 应用内扫码、刷新、取消、获取 AppID/Secret/OpenID | 官方 connector；宿主轮询和 SVG 渲染；密钥仅进 DSH 凭据库；界面仅取得公开身份与引用。关闭面板或卸载取消任务。扫码成功后保存渠道并启用。 |
| 手工凭据 | 详细设置填写 AppID、OpenID；凭据管理可检查已有引用的状态，或将手工 AppSecret 存为新的宿主凭据引用；保留原凭据，不回显 Secret。 |
| WebSocket、token、heartbeat、resume、断线重连 | 全部交给官方 SDK；`ready/resumed/disconnected` 映射现有运行状态，不新增重试体系。 |
| 所有者私聊、历史、引用、清洗、去重 | 仅支持固定所有者的私聊；群消息与群审批回调均拒绝，不创建群会话、不发送群消息。 |
| 每个聊天独立会话、恢复会话 | 使用原有 binding key、DSH 原生会话及持久化 outbox；不同账号、目的地、所有者、工作区、权限不串会话。 |
| 文字、Markdown、长文本 | 官方切分器并补充超长单行硬上限；优先被动回复，复用官方 msg/event 窗口与额度模块；额度耗尽才按官方方式主动发送。 |
| 私聊流式 | 官方 `openStream/update/complete`。先持久化投递状态再发送首帧；错误或中断记为 uncertain，不另发整篇静态内容。终态先等待 DSH flush。 |
| 图片、视频、文件接收 | 下载到当前绑定工作区 `.messaging-channels/qqbot-media`，路径和类型加入消息；当前消息及引用附件都支持。HTTPS、大小与时限校验；默认单附件 200 MiB；24 小时过期文件在下一次附件接收时清理。 |
| 语音接收 | 使用 QQ 自带 ASR 转写；同时保留音频附件供宿主工具使用。没有转写时不编造识别文本。 |
| 图片理解、OCR、截图/图表分析 | `qqbot_describe_image`；使用该 Agent 的 fs 和 attachments 服务，主模型或单独配置的视觉模型，10 MiB、120 秒上限；模型须声明支持图片。 |
| 图片、视频、语音、文件发送 | 官方 SDK 四种媒体发送器。`channel_send_media` 和官方工具名 `qqbot_send_file` 共用原有读取、单次审批和投递凭据流程；`file_path` 按扩展名选媒体。原项目 20 MiB 出站上限继续生效。WAV/MP3/SILK 使用原生语音，其他格式明确以音频文件交付。 |
| `/new /reset /clear` | 新建渠道会话，保留历史会话；不重写权限配置。 |
| `/compact` | 当前 Agent preset 的官方 compaction 服务；忙时明确提示；冷会话先按原生规则恢复。 |
| `/model [provider/model]` | 显示可点击的宿主模型列表、校验后切换并持久化偏好；保留上下文。使用 DSH 0.2.2 的公开 `agent.model.select()`；不再保留旧版模型接口分支。 |
| `/preset [id]` | 查询/校验宿主 Agent preset；保存为新会话默认；不改变 permission preset。 |
| `/stop /bot-ping /bot-version /bot-me /bot-status /bot-help` | 已接入；原有 `/cancel /status /help` 仍可用。 |
| 桌面续聊/服务回合主动推送 | 默认 `externalTurns=c2c`；可设 off。定时等服务回合按官方方式主动投递。走现有 outbox，重放不重复发送。仅监视精确绑定会话。 |
| 审批按钮和问答 | 审批按钮转成原有一次性 `/approve` 或 `/deny`；校验固定所有者与目的地后才进入原有持久化处理。DSH 桌面/渠道共享审批、权限规则、过期和撤回实现不变。问答仍使用项目已确定的 `/answer` 与宿主优先规则。 |
| 工具过程展示 | 直接复用官方工具结果 presenter；错误始终展示，成功结果由 QQ 设置开关控制，结构化终端／读取／diff 预览最多 1500 字符。只取当前绑定 Agent 的事件。 |
| 自动文件交付 | 宿主原生 present 的校验结果自动进入现有文件审批、Agent fs、20 MiB 上限和投递凭据。每轮默认最多 4 份，可关闭或调整；QQ 输入及当前绑定会话的桌面／服务输入均支持，后两者遵守原主动推送策略。 |
| 设置、凭据和版本 | 原生设置 → Messaging Channels → QQ Bot 设置；流式、桌面回复推送、工具结果、自动交付开关；/bot-settings 提示入口和当前选项。本源码构建的界面与 /bot-version 显示 1.1.0，界面还显示宿主控制器启动时间；此次版本整理尚未部署。 |
| 工具、执行队列、处理取消、闲置会话 | 继续由本项目 DSH 原生组合负责；未引入官方插件的另一套 SessionManager/并发队列/独立审批生命周期。 |

## 必须保留的差异

官方默认开放所有私聊与群聊、为陌生 peer 自动建 Agent；与本项目“固定所有者、固定目的地和显式权限预设”的既有边界冲突，因此没有搬开放访问策略。每个机器人只启用一个绑定，避免多条 WebSocket 消费同一机器人；多个绑定可使用不同机器人。按用户要求仅保留所有者私聊；群聊路由、设置、@ 门控及群回复窗口已经裁撤。

官方 `present` 交付物自动上传和任意目标参数没有绕过本项目媒体审批：所有实际文件外发仍通过既有 `channel_send_media` 审批和固定收件人执行。当前宿主的 present 在 tools/result 时才产生声明事件；为保持共享审批的有效轮次，自动交付在 present 的 post-execute 阶段、原轮次结束前等待批准并发送，而不是脱离轮次在 turn/end 后上传。保留原有 20 MiB 出站上限及工作区路径限制。问答按钮外观及两分钟一次性凭据生命周期沿用已有设计，没有换成官方另一套问答/审批状态机。

不自动改宿主 settings.yaml 的模型能力声明。视觉模型、图片附件服务、compaction 服务需要由现有 Agent preset 正确提供；缺失时返回明确错误，而非悄悄改宿主配置。不会自动安装 ffmpeg、解码器或额外模型，也不提供语音合成。

## 连接设置

Messaging Channels → 所属 Agent → 添加 QQ Bot → 扫码。成功后 AppID、所有者 OpenID、凭据引用会填入草稿；确认已有工作区和 permission preset，保存并启动。二维码过期可刷新。扫码前不解析真实密钥，未启用绑定不会启动 QQ 网关。

手工配置形态如下；Secret 预先存到宿主凭据 `QQBOT_APP_SECRET`，不放在 JSON 中：

```json
{
  "id": "owner-qqbot",
  "enabled": false,
  "cwd": "/absolute/existing/workspace",
  "credentialRef": "QQBOT_APP_SECRET",
  "permissionPreset": "existing-host-permission-preset",
  "channel": {
    "id": "owner-qqbot",
    "kind": "qqbot",
    "appId": "12345678",
    "ownerUserId": "OWNER_OPENID_FROM_QR",
    "streaming": true,
    "externalTurns": "c2c"
  }
}
```

`ownerUserId` 是所有者的私聊 OpenID，不是 QQ 号。配置中不再提供 scope、groupId 或 requireMention。视觉可填写 `visionProvider` 和 `visionModel`；两项都不填时使用当前模型。不要填空字符串。

## 真实联调与发布前事项

离线验证不读取真实凭据，不扫码或发送真实消息，也不调用付费模型；后续已按用户指示本地安装并重启 DSH。真实验收需要获准使用的机器人、其固定所有者私聊身份，以及开放平台为它启用的 Markdown、键盘、媒体、文件和流式权限。真实验证应覆盖扫码及重启、私聊身份校验及群消息拒绝、文字/图片/视频/语音/文件、长回复/流式、桌面和 QQ 双端同一审批、模型/会话命令、网络断开恢复和主动推送。主动消息与文件能力受平台权限、额度及回复窗口约束，SDK 报错不代表已发送，uncertain 不自动补发。

许可方面：官方插件和 Node SDK 为 MIT，完整声明保留在 THIRD_PARTY_NOTICES.md。已发布的 connector 1.2.0 包元数据为 UNLICENSED，不能把它宣称为 MIT；这里以独立 npm 依赖调用，不复制或打包其源码。对外发布前须核实该包的使用和分发授权。

## 审批按钮状态与实际限制

QQ 原生 visited_label 显示中性的“已提交，请看结果”，group_id 保留互斥分组。只有共享 broker 实际校验并消费一次性请求后才确认交互成功，确认先于后续回复，按钮平台权限沿用官方 permission.type=2；实际授权仍由服务端固定所有者、固定目的地及原一次性凭据控制。指定 OpenID 的平台按钮权限会在部分 QQ 客户端阻断点击，因此不使用它代替服务端鉴权。真实 SDK 的 HTTP 请求已用合成凭据与完全替换的 fetch 验证这些字段未被丢弃。旧卡片不会追溯改变；点击本身不表示授权，实际结果以带同一短编号的 DSH 中文结果消息为准。过期卡片明确提示失效且没有通过本卡片授权；桌面仍可处理其原生待批请求。QQ 客户端实际变灰仍需要在新生成卡片上验证，不能将离线序列化测试等同于客户端验收。未加入自动撤回或通用消息编辑。

## 会话身份与关闭期间的持久化

QQ 的会话身份现在只包含固定绑定、工作区、权限预设、主模型及 QQ 目的地身份；流式、工具结果、文件交付、视觉和推送设置不再改变会话分区。升级会优先复制当前全量哈希对应的路由记录到稳定身份，携带原会话的 scopeKey；原路由记录、两个既有会话和历史文件均保留，不合并内容、不新建第三个会话。此前 .14 新增 showToolResults、sendPresentedFiles、maxFiles 默认值进入旧的全字段哈希，确实造成一次会话拆分。

关闭 NativeSession 时先等待已开始的终态 flush，再让 SDK 完成句柄销毁和最终 drain；关闭阶段的队列取消不再与已移除的 writer 竞争执行 live flush。关闭后从持久化记录确认已完成／已取消的结果，无法确认时仍明确标记 uncertain，不重放输入或重试文件外发。


## 独立审核后的交付边界

QQ 命令在 `qqbot-commands.ts` 中处理，通用桥接层只提供重置、恢复与回执操作。QQ 工具和过程展示由 `qqbot-agent.ts` 组合。渠道、桌面和服务回合的 `present` 都进入同一个 `qqbot-presented.ts` 入口，共享本轮限额与去重；手工发送和自动文件交付共用 `approved-media.ts` 的审批 → Agent fs → flush → 持久化投递流程。可选 QQ 投递及失败提示抛错不会改变已成功的宿主 `present` 结果。

被动回复额度耗尽或 ID 过期时，在任何流式首帧发送前检查 SDK 所需的 msgId；没有可用 ID 时，仅在终态静态投递一次。已经尝试流式外发后出错仍为 uncertain，禁止补发。断线期间完成的桌面文字答复先保存为 pending；重连重新读取 outbox。获取发送对象失败而尚未外发时保留 pending；真正外发结果不明仍标记 uncertain，不自动重试。

升级兼容仅接受 .17 私聊配置遗留的 `scope=c2c` 与布尔 `requireMention`，解析时移除，不改变私聊身份；`scope=group`、`groupId` 及群主动推送配置继续明确拒绝，不自动转换群目的地。

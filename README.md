# Messaging Channels · DSH 渠道插件

**默认分支 `main` 现为 DSH 渠道插件产品线。旧独立 macOS App 已归档至 `archive/standalone-macos-main-20261104`，历史完整保留。**

将 iMessage、Telegram、微信 iLink 和 QQ Bot 消息送入 **DeepSeek Harness（DSH）** 的原生会话，并回传执行结果。当前仅支持 DSH `0.2.2-rc.1`，开发依赖与该宿主版本一致。

DSH 负责 Agent、模型、工具、权限、执行队列、取消和会话日志；本插件负责消息渠道、固定身份绑定、去重和回复投递。宿主与浏览器端均为原生 Cordis 插件，没有独立平台、服务安装器或执行后端。

**`1.1.0` 已移除 Discord 和飞书接入；旧版 `1.1.0-dsh.13` 仍含这两个渠道。** 旧配置的安全处理见[迁移指南](docs/dsh-channel-migration.md#removed-channel-configurations)。

## 安装

本版为 **`1.1.0`**。DSH 插件已成为 `main`，版本号改用普通 SemVer，不再添加用于区分旧 macOS App 的 `-dsh.N` 后缀。包名仍为 `@showin2333/dsh-plugin-channels`；旧 App 留在归档分支，既有发布版本与 Git 标签保留。`1.1.0` 高于此前的 `1.1.0-dsh.N` 预发布版本，不需要重置版本序列。

本版支持 DSH `0.2.2-rc.1`。iMessage 通道额外要求 macOS 与本机 Messages；Telegram、微信 iLink、QQ Bot 跨平台。

npm 包：`@showin2333/dsh-plugin-channels`。安装后以 bundle 形式挂载两条 Cordis 行（`dsh-channels` 与项目分组），浏览器面板由 `dsh.client` 自动发现。

原 npm 名称 `@showin2333/dsh-channels` 已迁至此名称。升级保留设置行 ID、渠道绑定与会话记录；先停止旧包，再切换依赖和模块引用，勿同时加载两个包。详见迁移指南。

本版 `1.1.0` 已在 npm 发布；市场索引更新前，市场入口可能仍显示旧版，建议用下面的命令直接安装。

- **直接安装**：DSH → 插件 → 安装，输入 `@showin2333/dsh-plugin-channels@1.1.0`。
- **市场安装**：先启用 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，在 插件 → 发现 → 添加索引源 填入下方地址，再从卡片安装。
- **本地开发**：`pnpm install && npm run build`，在 profile 的 `dependencies` 中以 `link:` 指向本仓库。

索引地址：`https://cdn.jsdelivr.net/gh/ShoWin2333/agent-imessage@main/market/index.json`

安装后不会自动连接任何渠道：先按「Desktop 管理面板」配置 workspace、权限预设和凭据引用，再显式启用绑定。升级需要先卸载再安装，DSH 目前没有原地更新动作。

QQ Bot 在独立干净基线上按腾讯官方 DSH 插件重做，含扫码、所有者私聊、媒体、流式和原生会话命令，审批沿用现有机制。详见[官方功能对照、差异与联调事项](docs/qqbot.md)。该能力包含于 `1.1.0`。扫码绑定依赖可选包 `@tencent-connect/qqbot-connector`；安装时取不到它，面板里仍可手动填写 AppSecret。

## 当前闭环

- 三种渠道保留原有适配器与身份过滤：iMessage 的指定号码 DM、Telegram 的指定 Bot/Owner 私聊、微信的指定账号/Owner/上下文。
- 空闲时文字任务进入 DSH 原生 followup；同一渠道正在执行的轮次内，追加文字通过 steer 在下一步接收；宿主直接发起的轮次不会被渠道接管。渠道游标前进前等待 inbox 落盘。DSH 的 `claimed` 事件关联单条输入和 turn，`turn/end` 后显式 flush 再回传结果。
- `/cancel`、`/stop` 取消本绑定当前与排队的工作；`/status` 查看绑定会话，`/help` 查看命令。取消不等待外发完成。
- 外部消息 ID 去重保存在 DSH storage domain；不同渠道、账号、Owner、目的地、工作区、权限配置之间不共用会话。
- 重启恢复已完成但未发送的结果；发送中崩溃或发送异常标为 `uncertain`，不自动重发。未完成的旧输入不自动重跑；恢复 Agent 后清理旧 inbox，防止新输入意外唤醒旧任务。

与 Telegram、微信或 iMessage 绑定的 DSH 会话需要工具审批时，手机和 DSH 桌面可以处理同一请求。Telegram 可点按钮，微信和 iMessage 可回复提示中的短命令。先提交的有效决定生效，两边只批一次。是否需要审批由 DSH 会话权限决定。问答仍由 DSH 优先处理，宿主没有问答处理器时转到原渠道。`/approve <凭据>` 仅允许本次操作；`/deny <凭据>` 拒绝；`/answer <凭据> <答案>` 返回原生结构化问答。单题可用选项数字或 `text:自由文本`，多题使用包含所有题目 ID 的 answers JSON。计划审批完整展示详情，必须明确选择原选项；不会把自由文本或推荐项当成批准。

临时凭据绑定当前渠道、精确 Agent 实例和正在执行的轮次，默认两分钟过期；渠道过期或不可用时，仍可在 DSH 桌面处理，桌面保留原生请求生命周期。结算或过期后会更新按钮或发送状态提示。未确认送达时不能批准；取消、断线、执行结束、卸载及重启都会使其失效。过期或重放命令不进入模型。DSH 的 `never` 审批策略直接拒绝操作。任一端提交有效决定后，插件会取消另一端的等待：桌面卡片通过 DSH 原生取消信号撤回，渠道按钮或状态提示更新为最终结果。外部消息更新失败不恢复授权凭据；迟到的回答不会再次授权。普通未绑定的桌面对话仍由 DSH 原生处理。具体组合限制见迁移指南。

渠道 Agent 新增 `channel_send_media` 工具：`{ "path": "outputs/report.pdf", "kind": "file" }`，`kind` 可选 `image`、`file`、`voice`。只发送当前绑定收件人，不接受任意聊天目标。上传先经过 DSH 原生审批，再通过 Agent 自己的文件系统读取绑定工作区内文件；单文件最多 20 MiB。发送前持久化投递凭据；超时或中断标为 `uncertain`，不自动重发。

图片优先使用渠道原生图片/附件展示；语音优先原生语音消息，不兼容时明确报告文件降级。`voice` 发送已有音频，不是文字转语音；QQ Bot 可收取媒体并交给原生任务处理，也支持绑定会话的服务回合主动投递；其他渠道的入站能力保持原样。

保留渠道的媒体能力：

| 渠道 | 图片 | 语音 |
| --- | --- | --- |
| iMessage | 原生附件展示 | 原生语音；Spectrum 完成编码 |
| Telegram | `sendPhoto` | `sendVoice`；支持 MP3/M4A/Ogg Opus |
| 微信 iLink | 原生 `image_item` | 当前未验证原生 bot 语音发送，明确降级音频文件 |

Telegram 的 `voice` 请求会在宿主具备 ffmpeg、Agent 子进程与沙箱能力时，通过受限管道转换为单声道 Ogg Opus，并校验解码后的音频长度（最长十分钟）。不写临时文件、不启用网络协议、不自动安装依赖；能力缺失会在结果中说明。微信图片协议依据腾讯官方 `@tencent-weixin/openclaw-weixin@2.4.10` 发布源码核实；共享类型中的语音字段不等于已证实的下行发送能力。网络发送失败不自动改用文件重发。取消已开始的第三方上传是尽力而为，尤其 iMessage SDK 无中途撤回能力。

## Agent 只读工具

插件注册一个只读工具 `channel_status`：返回已配置渠道的启停状态、连接阶段和稳定错误码，不含消息内容、凭据或会话标识。宿主未安装/提供 `tools` 服务时插件不会加载。

## Desktop 管理面板

安装后按 **⌘, → Messaging Channels**，打开 DSH 设置侧栏中的独立插件设置项。面板提供四类渠道、项目路径与宿主目录选择接口、宿主已配置模型与推理强度、凭据引用、身份限制、实际运行状态及显式启停。新增绑定默认停用；保存与启动是两个动作。保存使用宿主配置修订号，冲突或失败保留草稿，取消重新载入宿主已保存值。运行中的渠道也可编辑草稿；保存前须确认仅重新连接当前渠道，原会话历史保留。按左侧 Agent 项目选择消息入口，各渠道独立保存、取消及选择宿主模型；不设置模型覆盖时使用 DSH 默认。原生 Workspace 贡献会将精确属于本插件的会话归入对应项目，后续新会话自动挂接。

左侧 Agent 现在是持久化的插件配置分组：点击「新增 Agent」，填写名称和默认项目目录，即可保存没有渠道的空分组；之后添加渠道，新渠道默认使用该目录并保持停用。渠道可使用自己的目录、模型与权限预设。分组的默认目录只用于新增渠道时预填；当前渠道的 DSH 项目归属按宿主报告显示，不受未保存目录草稿影响。这里的分组不会新建 DSH 原生运行中 Agent。

「移除渠道」移除当前渠道配置；删除最后一条渠道后，空 Agent 仍保留。「移除 Agent」会移除该分组及所属渠道配置。确认框逐条列出渠道，说明哪些将停止，并提示丢弃所选范围内的草稿。**会话历史、宿主凭据、项目文件与 DSH Workspace 元数据均保留**；其他 Agent 和渠道不受影响。保存成功表示宿主接受了配置，渠道停止由宿主随后执行。

配置新增独立的 `agents` 数组（`id`、`name`、`cwd`、`bindingIds`），最多 32 个分组。旧配置未列入分组的绑定仍按原来的 ID 前缀和目录推算；首次保存时一起持久化。分组元数据不写入 binding，不改变既有渠道 ID、会话键、去重和收件进度。新建、渠道保存与移除使用一次带修订号的原生 Settings 修改，同时提交绑定和分组，避免只写一半；确认后若目标配置被其他窗口修改，须重新核对。删除只作用于确认框列出的已保存渠道；本地草稿标识只用于清理草稿，若该标识被并发保存为渠道则拒绝操作，须重新确认。

面板只保存凭据引用名称；名称存在不表示凭据已配置。默认模型跟随宿主，不创建新账号或密钥。权限预设必须已存在于宿主。跨字段和账号唯一性使用同一纯配置 Zod 校验；原生 Settings schema 保持声明式以兼容宿主二次序列化。外部绕过面板写入的非法配置会被运行入口拒绝，保留现有消费者并显示错误；持久化的非法外部配置须修正后才能正常重启。

## 插件组合

包声明 `dsh.bundle.patch`，默认 patch 加载插件但不配置任何绑定，因此不会连接真实渠道。宿主必须提供原生 Agent factory、session persistence、storage domain、credentials、Agent preset、default model 和 permission preset 服务。

以下为 **示例配置**，不会被本项目自动应用。`credentialRef` 仅引用宿主已有凭据；不要把 Token 或 Secret 写入 YAML。`cwd` 必须是现有绝对路径，`permissionPreset` 必须由宿主预先定义；插件不创建登录或扩大权限。

```yaml
- id: dsh-channels
  name: '@showin2333/dsh-plugin-channels'
  config:
    bindings:
      - id: owner-telegram
        cwd: /absolute/existing/workspace
        permissionPreset: workspace-write
        credentialRef: TELEGRAM_BOT_TOKEN
        channel:
          id: telegram
          kind: telegram
          botId: '123456'
          ownerUserId: '234567'
```


其他渠道的 `channel` 字段：

```yaml
# iMessage；credentialRef 指向 Photon project secret
channel:
  id: imessage
  kind: imessage
  projectId: existing-photon-project
  senderPhoneNumber: '+15551234567'
  assignedPhoneNumber: '+15557654321'

# 微信；credentialRef 指向现有 iLink token；weixin 与 channel 同级
channel:
  id: weixin
  kind: weixin
  accountId: existing-bot-account
weixin:
  ownerUserId: existing-owner
  baseUrl: https://ilinkai.weixin.qq.com/

```

同一个 Bot、微信账号或 Photon project 只能有一个消费者。真实切换前需核对旧消费者和备份。凭据轮换需由宿主更新引用并重新加载绑定。

## 本地验证

```sh
# 使用 pnpm 11.28.5（已核实的 Desktop 自带版本）
pnpm install --frozen-lockfile --ignore-scripts
npm run check
```

检查包括类型检查、合成消息/模拟渠道测试、构建和打包清单检查。开发依赖、主锁文件和运行时 peer 均固定在当前支持的 `0.2.2-rc.1`，不再保留旧 SDK 兼容分支。`cordis` 和 `zod` 也固定在经过验证的版本。没有真实消息或付费模型测试脚本。

接口依据、恢复语义和已知边界见 [迁移指南](docs/dsh-channel-migration.md)。[English](README.en.md) · [安全边界](SECURITY.md)

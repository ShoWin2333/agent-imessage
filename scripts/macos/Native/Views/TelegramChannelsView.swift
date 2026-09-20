import SwiftUI

struct TelegramChannelsView: View {
    @ObservedObject var store: GatewayStore
    @State private var adding = false
    @State private var saved = false
    var body: some View {
        Section("Telegram · Bot") {
            if saved {
                Label("Telegram Bot 已保存。请到 Agent 的消息入口选择绑定。",systemImage:"checkmark.circle.fill")
                    .foregroundStyle(.green).fixedSize(horizontal:false,vertical:true)
            }
            ForEach(store.state.objects("telegramAccounts").map { $0.text("botId") }, id: \.self) { id in
                if let account = store.state.objects("telegramAccounts").first(where: { $0.text("botId") == id }) {
                    TelegramBotEditor(store: store, account: account)
                }
            }
            if adding {
                TelegramBotEditor(store: store, account: nil, onSaved: { adding = false; saved = true })
                Button("取消添加") { adding = false }
            } else {
                Button("添加 Telegram Bot") { saved = false; adding = true }
            }
            Text("在此添加和验证 Bot，再到 Agent 的「消息入口」选择绑定。每个 Bot 只能绑定一个 Agent。绑定后请向 Bot 发送 /start。").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct TelegramBotEditor: View {
    @ObservedObject var store: GatewayStore
    let account: JSONObject?
    var onSaved: () -> Void = {}
    @State private var token = ""
    @State private var owner = ""
    @State private var editing = false
    @State private var submitting = false
    @State private var feedback = ""
    @State private var failed = false
    @State private var showingError = false
    private var botId: String { account?.text("botId") ?? "" }
    private var projects: [JSONObject] { store.state.object("config").objects("routes") }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let account {
                Text(account.text("username").isEmpty ? "Bot \(botId)" : "@" + account.text("username")).font(.headline)
                Text("Bot ID：\(botId) · 允许用户：\(account.text("ownerUserId"))").font(.caption).textSelection(.enabled)
                Text(status(account)).foregroundStyle(.secondary)
            } else { Text("添加 Telegram Bot").font(.headline) }
            if account == nil || editing {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Bot Token")
                    SecureField(account == nil ? "粘贴 @BotFather 提供的 Token" : "留空保留现有 Token", text: $token)
                        .accessibilityLabel("Telegram Bot Token")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("你的 Telegram 数字用户 ID")
                    TextField("例如：123456789（不是用户名或手机号）", text: $owner).accessibilityLabel("Telegram 用户 ID")
                }
                Text("这是允许操作 Bot 的你本人账号 ID，不是 @用户名、手机号或 Bot ID。").font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal:false,vertical:true)
                Link("查询我的数字 ID（第三方 @userinfobot）",destination:URL(string:"https://t.me/userinfobot")!)
                Text("在 Telegram 打开后点击 Start，复制回复中的数字 ID；不要发送 Bot Token。").font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal:false,vertical:true)
                if !owner.isEmpty, let reason = TelegramFormValidation.ownerError(owner) {
                    Text(reason).font(.caption).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true)
                }
                Text("Bot ID 和用户名由 Token 自动验证识别。").font(.caption).foregroundStyle(.secondary)
            }
            if let account, !account.text("routeId").isEmpty {
                Button("前往 Agent 管理绑定") { store.openChannelSettings(account.text("routeId")) }
            }
            HStack {
                if account == nil || editing {
                    Button(submitting ? "正在验证…" : (account == nil ? "验证并添加 Bot" : "验证并保存")) {
                        submit()
                    }.disabled(submitting)
                    if editing { Button("取消修改") { token = ""; editing = false } }
                } else {
                    Button("修改凭据") { owner = account?.text("ownerUserId") ?? ""; editing = true }
                }
            }
            if submitting {
                HStack { ProgressView().controlSize(.small); Text("正在连接 Telegram 并保存，请稍候…") }
            } else if !feedback.isEmpty {
                Label(feedback,systemImage:failed ? "exclamationmark.circle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(failed ? Color.red : Color.green)
                    .fixedSize(horizontal:false,vertical:true)
            }
        }
        .alert("Telegram Bot 未保存",isPresented:$showingError) { Button("知道了",role:.cancel) {} } message: { Text(feedback) }
        .textFieldStyle(.roundedBorder)
        .labelsHidden()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        .onAppear { owner = account?.text("ownerUserId") ?? "" }
    }
    private func submit() {
        guard !submitting else { return }
        if let reason = TelegramFormValidation.ownerError(owner) {
            feedback = reason; failed = true; showingError = true; return
        }
        if account == nil && token.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            feedback = "请粘贴 @BotFather 提供的 Bot Token。"; failed = true; showingError = true; return
        }
        feedback = ""; failed = false; submitting = true
        Task {
            let success = await store.saveChannelAccount("api/telegram/save", ["botId":botId,"token":token,"ownerUserId":owner])
            submitting = false
            if success {
                token = ""; editing = false
                feedback = "Telegram Bot 已保存。请到 Agent 的消息入口选择绑定。"
                onSaved()
            } else {
                feedback = store.notice; failed = true; showingError = true
            }
        }
    }
    private func status(_ account: JSONObject) -> String {
        let id = account.text("routeId")
        guard !id.isEmpty else { return "未绑定 Agent" }
        let project = projects.first { $0.text("id") == id }
        let channel = store.runtime(id).objects("channels").first { $0.text("id") == account.text("channelId") }
        let phase = channel?.text("phase") ?? "stopped"
        let label = ["listening":"已连接","starting":"连接中","stopped":"已停止","retrying":"重连中","failed":"连接失败"][phase] ?? phase
        return "已绑定：\(project?.text("label",id) ?? id) · \(label)"
    }
}

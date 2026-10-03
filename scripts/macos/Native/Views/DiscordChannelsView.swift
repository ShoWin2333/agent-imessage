import SwiftUI

struct DiscordChannelsView: View {
    @ObservedObject var store: GatewayStore
    @State private var adding = false
    var body: some View {
        Section("Discord · Bot") {
            ForEach(store.state.objects("discordAccounts").map { $0.text("botId") }, id: \.self) { id in
                if let account = store.state.objects("discordAccounts").first(where: { $0.text("botId") == id }) {
                    DiscordBotEditor(store:store,account:account)
                }
            }
            if adding {
                DiscordBotEditor(store:store,account:nil,onSaved:{adding = false})
                Button("取消添加") { adding = false }
            } else { Button("添加 Discord Bot") { adding = true } }
            Link("打开 Discord Developer Portal",destination:URL(string:"https://discord.com/developers/applications")!)
            Text("创建 Bot 并安装到你的服务器；只需查看频道、发送消息和附加文件权限。无需 Message Content 特权。Token 仅在本机保存，请勿发送到聊天中。添加后，在 Agent 消息入口选择 Bot；默认仅接收你本人的私聊。").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct DiscordBotEditor: View {
    @ObservedObject var store: GatewayStore
    let account: JSONObject?
    var onSaved: () -> Void = {}
    @State private var token = ""
    @State private var owner = ""
    @State private var editing = false
    @State private var submitting = false
    @State private var error = ""
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            if let account {
                Text(account.text("username",account.text("botId"))).font(.headline)
                Text("Bot ID：" + account.text("botId") + " · 允许用户：" + account.text("ownerUserId")).font(.caption).textSelection(.enabled)
                ChannelAccountBinding(store:store,kind:"discord",accountID:account.text("botId"))
            }
            if account == nil || editing {
                SecureField(account == nil ? "Discord Bot Token" : "留空保留现有 Token",text:$token)
                TextField("你的 Discord 数字用户 ID",text:$owner)
                Text("Discord 设置 → 高级 → 开发者模式；右键你本人的头像 → 复制用户 ID。不是用户名或 Bot ID。").font(.caption).foregroundStyle(.secondary)
                if !owner.isEmpty, let reason = DiscordFormValidation.ownerError(owner) {
                    Text(reason).font(.caption).foregroundStyle(.red)
                }
                HStack {
                    Button(submitting ? "正在验证…" : "验证并保存 Bot") { submit() }.disabled(submitting)
                    if editing { Button("取消修改") {token = ""; editing = false; error = ""} }
                }
            } else {
                Button("修改凭据 / 允许用户") {owner = account?.text("ownerUserId") ?? ""; editing = true}
            }
            if !error.isEmpty {Text(error).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true)}
        }.textFieldStyle(.roundedBorder).padding(.vertical,6)
        .onAppear {owner = account?.text("ownerUserId") ?? ""}
    }
    private func submit() {
        guard !submitting else {return}
        if let reason = DiscordFormValidation.ownerError(owner) {error = reason; return}
        if account == nil && token.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {error = "请在本机填写 Discord Bot Token。"; return}
        submitting = true; error = ""
        Task {
            let saved = await store.saveChannelAccount("api/discord/save",["botId":account?.text("botId") ?? "","token":token,"ownerUserId":owner])
            submitting = false
            if saved {token = ""; editing = false; onSaved()}
            else {error = store.notice}
        }
    }
}

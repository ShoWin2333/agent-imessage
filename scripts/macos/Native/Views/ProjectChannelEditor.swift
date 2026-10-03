import SwiftUI

struct ProjectChannelEditor: View {
    @ObservedObject var store: GatewayStore
    @ObservedObject var draft: ProjectDraft
    @State private var expandedChannels: Set<String> = []
    private func title(_ kind: String) -> String { ["imessage":"iMessage","weixin":"微信","telegram":"Telegram","discord":"Discord"][kind] ?? kind }
    private func key(_ kind: String) -> String { ChannelAccountOption.key(kind) }
    private func accounts(_ kind: String) -> [JSONObject] {
        ChannelAccountOption.accounts(kind,state:store.state)
    }
    var body: some View {
        ForEach(draft.channels.map { $0.text("id") },id:\.self) { id in
            if let channel = draft.channels.first(where: { $0.text("id") == id }) {
                let kind = channel.text("kind")
                let options = ChannelAccountOption.options(kind,state:store.state,draft:draft,channelID:id)
                DisclosureGroup(title(kind) + " · " + id, isExpanded: Binding(get: { expandedChannels.contains(id) }, set: { if $0 { expandedChannels.insert(id) } else { expandedChannels.remove(id) } })) {
                    Picker(kind == "discord" ? "选择 Discord Bot" : "选择" + title(kind) + "账号", selection: Binding(get: { draft.channels.first { $0.text("id") == id }?.text(key(kind)) ?? "" }, set: { select($0, kind:kind, id:id) })) {
                        Text(kind == "discord" ? "选择已添加的 Discord Bot" : "选择已添加的账号").tag("")
                        ForEach(options) { option in
                            Text(option.title).tag(option.id).disabled(option.boundTo != nil)
                        }
                        if !channel.text(key(kind)).isEmpty && !accounts(kind).contains(where: { $0.text(key(kind)) == channel.text(key(kind)) }) {
                            Text(channel.text(key(kind)) + "（现有配置）").tag(channel.text(key(kind)))
                        }
                    }
                    if kind == "imessage" {
                        VStack(alignment:.leading,spacing:4) {
                            Text("允许联系的手机号（含国家区号）")
                            TextField("例如：+8613800000000",text:field(id,"senderPhoneNumber")).labelsHidden().textFieldStyle(.roundedBorder)
                        }
                        Text("接收号码：" + channel.text("assignedPhoneNumber")).font(.caption).foregroundStyle(.secondary)
                    }
                    if kind == "discord" {
                        Text("已添加 \(options.count) 个 Discord Bot；请选择要绑定到 " + draft.name + " 的 Bot。").font(.caption).foregroundStyle(.secondary)
                        Picker("消息位置",selection:Binding(get:{channel["guildId"] == nil ? "dm" : "guild"},set:{mode in
                            var channels = draft.channels
                            if let index = channels.firstIndex(where:{$0.text("id") == id}) {
                                if mode == "dm" {channels[index].removeValue(forKey:"guildId"); channels[index].removeValue(forKey:"channelId")}
                                else {channels[index]["guildId"] = ""; channels[index]["channelId"] = ""}
                                draft.setChannels(channels)
                            }
                        })) {
                            Text("仅本人私聊").tag("dm")
                            Text("指定服务器文字频道").tag("guild")
                        }
                        if channel["guildId"] != nil {
                            TextField("服务器 ID",text:field(id,"guildId"))
                            TextField("文字频道 ID",text:field(id,"channelId"))
                        }
                        Text("只接收允许用户；服务器频道中每条任务、指令和审批回复都需 @Bot。使用私人频道，避免其他成员看到结果。Discord 拥有独立的 Agent 会话。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button("解绑此入口",role:.destructive) { draft.setChannels(draft.channels.filter { $0.text("id") != id }) }
                }
            }
        }
        HStack {
            ForEach(["imessage","weixin","telegram","discord"], id: \.self) { kind in
                Button("绑定 " + title(kind)) { add(kind) }
            }
        }.disabled(draft.channels.count >= 8)
        Button("前往消息渠道添加 / 管理账号") { store.selection = "channels" }
        Text("选择账号后保存并应用。每个账号只能绑定一个 Agent；转移前请先在原 Agent 解绑并保存。解绑全部入口后项目会停用。").font(.caption).foregroundStyle(.secondary)
    }
    private func add(_ kind: String) {
        let id = kind == "imessage" && !draft.channels.contains(where: { $0.text("id") == "imessage" }) ? "imessage" : kind + "-" + UUID().uuidString.prefix(8)
        var channel: JSONObject = ["id":String(id),"kind":kind]
        if kind == "imessage" { channel.merge(["projectId":"","projectSecretEnv":"AGENT_PHOTON_MANAGED","senderPhoneNumber":"","assignedPhoneNumber":""]) { _,new in new } }
        else if kind == "weixin" { channel["accountId"] = "" }
        else { channel["botId"] = ""; channel["ownerUserId"] = "" }
        draft.setChannels(draft.channels + [channel]); expandedChannels.insert(String(id))
    }
    private func select(_ value: String, kind: String, id: String) {
        var channels = draft.channels
        guard let index = channels.firstIndex(where: { $0.text("id") == id }) else { return }
        channels[index][key(kind)] = value
        let account = accounts(kind).first { $0.text(key(kind)) == value } ?? [:]
        if kind == "telegram" || kind == "discord" { channels[index]["ownerUserId"] = account.text("ownerUserId") }
        if kind == "imessage" {
            channels[index]["assignedPhoneNumber"] = account.text("assignedPhoneNumber")
            channels[index]["senderPhoneNumber"] = account.text("senderPhoneNumber")
            channels[index]["projectSecretEnv"] = "AGENT_PHOTON_MANAGED"
        }
        draft.setChannels(channels)
    }
    private func field(_ id: String, _ key: String) -> Binding<String> {
        Binding(get:{draft.channels.first{$0.text("id") == id}?.text(key) ?? ""},set:{ text in
            var channels = draft.channels
            if let index = channels.firstIndex(where:{$0.text("id") == id}) { channels[index][key] = text; draft.setChannels(channels) }
        })
    }
}

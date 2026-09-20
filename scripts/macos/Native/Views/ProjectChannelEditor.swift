import SwiftUI

struct ProjectChannelEditor: View {
    @ObservedObject var store: GatewayStore
    @ObservedObject var draft: ProjectDraft
    @State private var expandedChannels: Set<String> = []
    private func title(_ kind: String) -> String { ["imessage":"iMessage","weixin":"微信","telegram":"Telegram"][kind] ?? kind }
    private func key(_ kind: String) -> String { ["imessage":"projectId","weixin":"accountId","telegram":"botId"][kind] ?? "" }
    private func accounts(_ kind: String) -> [JSONObject] {
        store.state.objects(["imessage":"photonAccounts","weixin":"weixinAccounts","telegram":"telegramAccounts"][kind] ?? "")
    }
    private func owner(_ kind: String, _ account: String, _ channelID: String) -> String? {
        for route in store.state.object("config").objects("routes") where route.text("id") != draft.id {
            if ProjectDraft(route).channels.contains(where: { $0.text("kind") == kind && $0.text(key(kind)) == account }) { return route.text("label",route.text("id")) }
        }
        if draft.channels.contains(where: { $0.text("id") != channelID && $0.text("kind") == kind && $0.text(key(kind)) == account }) { return "当前 Agent 的其他入口" }
        return nil
    }
    private func label(_ account: JSONObject, _ kind: String) -> String {
        if kind == "telegram", !account.text("username").isEmpty { return "@" + account.text("username") }
        if kind == "imessage" { return account.text("assignedPhoneNumber") + " · " + account.text("projectId") }
        return account.text(key(kind))
    }
    var body: some View {
        ForEach(draft.channels.map { $0.text("id") },id:\.self) { id in
            if let channel = draft.channels.first(where: { $0.text("id") == id }) {
                let kind = channel.text("kind")
                DisclosureGroup(title(kind) + " · " + id, isExpanded: Binding(get: { expandedChannels.contains(id) }, set: { if $0 { expandedChannels.insert(id) } else { expandedChannels.remove(id) } })) {
                    Picker("选择" + title(kind) + "账号", selection: Binding(get: { draft.channels.first { $0.text("id") == id }?.text(key(kind)) ?? "" }, set: { select($0, kind:kind, id:id) })) {
                        Text("选择已添加的账号").tag("")
                        ForEach(accounts(kind).map { $0.text(key(kind)) }, id: \.self) { accountID in
                            if let account = accounts(kind).first(where: { $0.text(key(kind)) == accountID }) {
                                let bound = owner(kind,accountID,id)
                                Text(label(account,kind) + (bound.map { "（已绑定：" + $0 + "）" } ?? ""))
                                    .tag(accountID).disabled(bound != nil)
                            }
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
                    Button("解绑此入口",role:.destructive) { draft.setChannels(draft.channels.filter { $0.text("id") != id }) }
                }
            }
        }
        HStack {
            ForEach(["imessage","weixin","telegram"], id: \.self) { kind in
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
        if kind == "telegram" { channels[index]["ownerUserId"] = account.text("ownerUserId") }
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

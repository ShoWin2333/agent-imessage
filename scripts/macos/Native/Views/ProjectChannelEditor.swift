import SwiftUI

struct ProjectChannelEditor: View {
    @ObservedObject var store: GatewayStore
    @ObservedObject var draft: ProjectDraft
    @State private var photonProjects: [JSONObject] = []
    @State private var selectedPhoton = ""
    var body: some View {
        ForEach(draft.channels.map { $0.text("id") },id:\.self) { id in
            if let channel = draft.channels.first(where: { $0.text("id") == id }) {
                DisclosureGroup(channel.text("kind") == "weixin" ? "微信 · \(id)" : "iMessage · \(id)") {
                    if channel.text("kind") == "weixin" {
                        Picker("微信机器人",selection:field(id,"accountId")) {
                            Text("选择已扫码绑定的机器人").tag("")
                            ForEach(accounts(current:channel.text("accountId")),id:\.self) { account in
                                Text(account + ownerLabel(account)).tag(account)
                                    .disabled(isOwnedElsewhere(account))
                            }
                        }
                    } else {
                        TextField("你的号码（含国家区号）",text:field(id,"senderPhoneNumber"))
                        TextField("Photon 项目 ID",text:field(id,"projectId"))
                        TextField("Photon 分配的号码",text:field(id,"assignedPhoneNumber"))
                        TextField("密钥环境变量",text:field(id,"projectSecretEnv"))
                        SecureField("Project Secret（留空保留已存密钥）",text:Binding(get:{draft.secrets[secretKey(id)] ?? ""},set:{draft.secrets[secretKey(id)] = $0; draft.dirty = true}))
                        HStack {
                            Button("加载已有 Photon 项目") { Task { if let result = await store.perform("api/photon/projects") { photonProjects = result.objects("projects") } } }
                            Button("创建 / 获取号码") { provision(id,existing:false) }
                        }
                        if !photonProjects.isEmpty {
                            Picker("已有项目",selection:$selectedPhoton) {
                                Text("选择 Photon 项目").tag("")
                                ForEach(photonProjects.indices,id:\.self) { i in Text(photonProjects[i].text("name") + " · " + photonProjects[i].text("id")).tag(photonProjects[i].text("id")) }
                            }
                            Button("使用所选项目 / 获取号码") { provision(id,existing:true) }.disabled(selectedPhoton.isEmpty)
                        }
                    }
                    Button("移除此入口",role:.destructive) { draft.setChannels(draft.channels.filter { $0.text("id") != id }) }
                }
            }
        }
        HStack {
            Button("添加 iMessage 入口") {
                let id = draft.channels.contains(where:{$0.text("id") == "imessage"}) ? "imessage-" + UUID().uuidString.prefix(8) : "imessage"
                draft.setChannels(draft.channels + [["id":String(id),"kind":"imessage","projectId":"","senderPhoneNumber":"","assignedPhoneNumber":"","projectSecretEnv":"PHOTON_" + draft.id.replacingOccurrences(of:"-",with:"_").uppercased()]])
            }
            Button("添加微信入口") { draft.setChannels(draft.channels + [["id":"weixin-" + UUID().uuidString.prefix(8),"kind":"weixin","accountId":""]]) }
        }.disabled(draft.channels.count >= 8)
        Text("先在「消息渠道」中绑定账号。机器人只能绑定一个项目；更换项目前先解绑并保存。关闭全部入口后项目会停用。").font(.caption).foregroundStyle(.secondary)
    }
    private func field(_ id: String, _ key: String) -> Binding<String> {
        Binding(get:{draft.channels.first{$0.text("id") == id}?.text(key) ?? ""},set:{ text in
            var channels = draft.channels
            if let index = channels.firstIndex(where:{$0.text("id") == id}) { channels[index][key] = text; draft.setChannels(channels) }
        })
    }
    private func secretKey(_ id: String) -> String { draft.value["channels"] == nil ? draft.id : draft.id + ":" + id }
    private func accounts(current: String) -> [String] {
        Array(Set(store.state.objects("weixinAccounts").map{$0.text("accountId")} + (current.isEmpty ? [] : [current]))).sorted()
    }
    private func ownerLabel(_ account: String) -> String { isOwnedElsewhere(account) ? "（已绑定其他项目）" : "" }
    private func isOwnedElsewhere(_ account: String) -> Bool {
        store.state.object("config").objects("routes").contains { route in
            route.text("id") != draft.id && route.objects("channels").contains { $0.text("accountId") == account }
        }
    }
    private func provision(_ id: String, existing: Bool) {
        guard let channel = draft.channels.first(where:{$0.text("id") == id}) else { return }
        let sender = channel.text("senderPhoneNumber")
        var body: JSONObject = ["id":draft.id,"name":draft.id,"sender":sender]
        if existing { body["projectId"] = selectedPhoton }
        Task {
            if let result = await store.perform(existing ? "api/photon/select" : "api/photon/provision",body) {
                field(id,"projectId").wrappedValue = result.text("projectId")
                field(id,"assignedPhoneNumber").wrappedValue = result.text("assignedPhoneNumber")
                // Server retains a selected credential until this project is saved.
                draft.secrets[secretKey(id)] = ""
                store.notice = "已获取号码，请保存并应用项目。"
            }
        }
    }
}

import SwiftUI

struct ChannelAccountBinding: View {
    @ObservedObject var store: GatewayStore
    let kind: String
    let accountID: String
    private var route: JSONObject? {
        let key = ["imessage":"projectId","weixin":"accountId","telegram":"botId"][kind] ?? ""
        return store.state.object("config").objects("routes").first { route in
            ProjectDraft(route).channels.contains { $0.text("kind") == kind && $0.text(key) == accountID }
        }
    }
    var body: some View {
        if let route {
            Text("已绑定：" + route.text("label",route.text("id"))).font(.caption).foregroundStyle(.secondary)
            Button("前往 Agent 管理绑定") { store.openChannelSettings(route.text("id")) }
        } else { Text("未绑定 · 请到 Agent 的消息入口选择此账号").font(.caption).foregroundStyle(.secondary) }
    }
}

struct PhotonChannelsView: View {
    @ObservedObject var store: GatewayStore
    @State private var adding = false
    @State private var projects: [JSONObject] = []
    @State private var selected = ""
    @State private var name = ""
    @State private var sender = ""
    var body: some View {
        ForEach(store.state.objects("photonAccounts").map { $0.text("projectId") },id: \.self) { id in
            if let account = store.state.objects("photonAccounts").first(where: { $0.text("projectId") == id }) {
                VStack(alignment:.leading,spacing:6) {
                    Text(account.text("assignedPhoneNumber")).font(.headline)
                    Text("Photon 项目：" + id).font(.caption).textSelection(.enabled)
                    ChannelAccountBinding(store:store,kind:"imessage",accountID:id)
                }.padding(.vertical,6)
            }
        }
        if adding {
            VStack(alignment:.leading,spacing:10) {
                Text("准备 iMessage 号码").font(.headline)
                Button("加载 Photon 项目") { Task { if let result = await store.perform("api/photon/projects") { projects = result.objects("projects") } } }
                Text("Photon 项目")
                Picker("Photon 项目",selection:$selected) {
                    Text("创建新项目").tag("")
                    ForEach(projects.map { $0.text("id") },id: \.self) { id in
                        if let project = projects.first(where: { $0.text("id") == id }) { Text(project.text("name",id)).tag(id) }
                    }
                }
                if selected.isEmpty {
                    Text("新项目名称")
                    TextField("填写名称",text:$name)
                }
                Text("你的手机号（用于申请号码，含国家区号）")
                TextField("例如：+8613800000000",text:$sender)
                HStack {
                    Button("获取并保存号码") { Task {
                        if await store.saveChannelAccount("api/photon/account",["name":name.isEmpty ? selected : name,"projectId":selected,"sender":sender]) { adding = false; name = ""; sender = "" }
                    } }.disabled(sender.isEmpty || (selected.isEmpty && name.isEmpty))
                    Button("取消") { adding = false }
                }
            }.labelsHidden().textFieldStyle(.roundedBorder).padding(.vertical,8)
        } else {
            Button("添加 iMessage 号码") { adding = true }
        }
        Text("在此准备号码与凭据，再到 Agent 的消息入口选择绑定；允许联系的手机号在 Agent 页设置。").font(.caption).foregroundStyle(.secondary)
    }
}

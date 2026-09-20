import SwiftUI

struct NativeTasksView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channelFilter: String
    let search: String
    private var channels: [JSONObject] { store.runtime(projectID).objects("channels").filter { channelFilter.isEmpty || $0.text("id") == channelFilter }.sorted { ($0["busy"] as? Bool == true ? 0 : 1) < ($1["busy"] as? Bool == true ? 0 : 1) } }
    private func rank(_ task: JSONObject) -> Int { task.text("execution") == "running" ? 0 : task.text("delivery") == "uncertain" ? 1 : 2 }
    var body: some View {
        if channels.allSatisfy({ $0.objects("tasks").isEmpty }) {
            ContentUnavailableView("尚无任务",systemImage:"text.bubble",description:Text("从绑定的微信或 iMessage 发送任务，或添加定时任务。早期版本的活动可在诊断记录中查看。"))
        }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(channels, id: \.self.textID) { channel in
                    ForEach(channel.objects("tasks").sorted { rank($0) == rank($1) ? ($0["startedAt"] as? Double ?? 0) > ($1["startedAt"] as? Double ?? 0) : rank($0) < rank($1) }.filter { search.isEmpty || ($0.text("input") + $0.text("result")).localizedCaseInsensitiveContains(search) }, id: \.self.textID) { task in
                        NativeTaskCard(store: store, projectID: projectID, channel: channel, task: task)
                    }
                }
            }.padding(.vertical, 8)
        }
    }
}

private struct NativeTaskCard: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channel: JSONObject
    let task: JSONObject
    @State private var answers: [String:String] = [:]
    @State private var confirmResend = false
    private var current: Bool { channel.object("current").text("taskId") == task.text("id") }
    private func act(_ action: String, request: String = "") {
        Task { await store.perform("api/tasks/control", ["routeId":projectID,"channelId":channel.text("id"),"taskId":task.text("id"),"action":action,"requestId":request,"answers":answers]) }
    }
    private var execution: String {
        switch task.text("execution") {
        case "completed": return "已完成"
        case "interrupted": return "已中断"
        case "failed": return "执行失败"
        default: return channel.object("current").text("phase", "运行中")
        }
    }
    var body: some View {
        GroupBox {
            VStack(alignment:.leading, spacing:12) {
                HStack {
                    Text(execution).font(.headline)
                    Spacer()
                    Text(channel.text("id")).foregroundStyle(.secondary)
                    if current { Button("停止", role:.destructive) { act("stop") } }
                }
                Text(task.text("input")).textSelection(.enabled)
                if !task.text("reason").isEmpty { Text(task.text("reason")).font(.caption).foregroundStyle(.secondary) }
                if current {
                    ForEach(channel.objects("requests"), id: \.self.textID) { request in
                        Divider()
                        Text(request.text("kind") == "approval" ? "需要审批" : "需要回答").font(.headline)
                        Text(request.text("details")).font(.callout.monospaced()).textSelection(.enabled)
                        Text("有效期至 " + Date(timeIntervalSince1970:(request["expiresAt"] as? Double ?? 0)/1000).formatted()).font(.caption).foregroundStyle(.secondary)
                        if request.text("kind") == "approval" {
                            HStack {
                                Button("允许本次") { act("approve", request:request.text("id")) }
                                Button("拒绝", role:.destructive) { act("deny", request:request.text("id")) }
                            }
                        } else {
                            ForEach(request["questions"] as? [String] ?? [], id:\.self) { id in
                                TextField(id, text:Binding(get:{answers[id] ?? ""},set:{answers[id] = $0}))
                            }
                            Button("提交回答") { act("answer", request:request.text("id")) }
                        }
                    }
                }
                if !task.text("result").isEmpty {
                    Divider()
                    Text(task.text("result")).textSelection(.enabled)
                    HStack {
                        Text(task.text("delivery") == "sent" ? "渠道已接受结果" : task.text("delivery") == "sending" ? "正在发送结果" : "结果已保存；发送尚未确认")
                            .font(.caption).foregroundStyle(.secondary)
                        if ["pending","uncertain"].contains(task.text("delivery")) {
                            Button("重新发送结果") { confirmResend = true }
                        }
                    }
                }
            }.padding(8).frame(maxWidth:.infinity,alignment:.leading)
        }
        .disabled(store.busy || !store.connected)
        .confirmationDialog("重新发送已保存的结果？上一次可能已有部分送达，本次不会重新执行任务。", isPresented:$confirmResend) {
            Button("重新发送") { act("resend") }
        }
    }
}

private extension Dictionary where Key == String, Value == Any {
    var textID: String { text("id") }
}

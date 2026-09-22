import SwiftUI

private struct TaskRow: Identifiable {
    let channel: JSONObject
    let task: JSONObject
    var id: String { channel.text("id") + ":" + task.text("id") }
}

struct NativeTasksView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channelFilter: String
    let search: String
    @State private var archiveChannel: String?
    private var channels: [JSONObject] { store.runtime(projectID).objects("channels").filter { channelFilter.isEmpty || $0.text("id") == channelFilter } }
    private func rank(_ task: JSONObject, _ channel: JSONObject) -> Int {
        if task.text("execution") == "running" { return channel.object("current").text("taskId") == task.text("id") && !channel.objects("requests").isEmpty ? 1 : 0 }
        return !task.text("result").isEmpty && ["uncertain","pending"].contains(task.text("delivery")) ? 1 : 2
    }
    var body: some View {
        HStack {
            Text("较早任务自动归档，完整内容可随时查看。").font(.caption).foregroundStyle(.secondary)
            Spacer()
            Menu("归档历史") {
                ForEach(channels, id: \.self.textID) { channel in Button(channel.text("id")) { archiveChannel = channel.text("id") } }
            }
        }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ForEach(0..<3, id: \.self) { section in
                    let rows = channels.flatMap { channel in channel.objects("tasks").map { TaskRow(channel:channel,task:$0) } }.filter { rank($0.task,$0.channel) == section && (search.isEmpty || ($0.task.text("input") + $0.task.text("result")).localizedCaseInsensitiveContains(search)) }.sorted { ($0.task["startedAt"] as? Double ?? 0) > ($1.task["startedAt"] as? Double ?? 0) }
                    if !rows.isEmpty {
                        Text(["运行中","等待处理","最近完成"][section]).font(.headline)
                        ForEach(rows) { row in
                            NativeTaskCard(store:store, projectID:projectID, channel:row.channel, task:row.task)
                        }
                    }
                }
                if channels.allSatisfy({ $0.objects("tasks").isEmpty }) { ContentUnavailableView("尚无最近任务",systemImage:"checklist",description:Text("发送任务即可开始，也可以查看归档历史。")) }
            }.padding(.vertical, 8)
        }
        .sheet(isPresented:Binding(get:{archiveChannel != nil},set:{if !$0 {archiveChannel=nil}})) {
            if let id = archiveChannel { NativeTaskHistoryView(store:store,projectID:projectID,channelID:id) }
        }
    }
}

struct NativeInteractionView: View {
    @ObservedObject var store: GatewayStore
    let request: JSONObject
    let submit: (String, [String:String]) -> Void
    @State private var answers: [String:String] = [:]
    @State private var expanded=false
    private var presentation: JSONObject { request.object("presentation") }
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            Text(presentation.text("title", "需要处理")).font(.headline)
            if presentation["generic"] as? Bool == true { Text(presentation.text("reason", "请展开完整请求详情，核对操作后再决定。")).foregroundStyle(.secondary) }
            if !presentation.text("command").isEmpty { Text(presentation.text("command")).font(.body.monospaced()).textSelection(.enabled) }
            if !presentation.text("cwd").isEmpty { LabeledContent("工作目录",value:presentation.text("cwd")) }
            if !presentation.text("reason").isEmpty { LabeledContent("原因",value:presentation.text("reason")) }
            if !presentation.objects("files").isEmpty {
                Text("将修改 \(presentation.objects("files").count) 个文件")
                ForEach(presentation.objects("files"),id:\.self.pathID) { file in
                    DisclosureGroup(file.text("path")) { Text(file.text("diff",file.text("kind"))).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            if presentation["extraPermissions"] as? Bool == true { Text("此请求包含额外权限，请展开详情核对后再决定。").foregroundStyle(.orange) }
            DisclosureGroup("完整请求详情",isExpanded:$expanded) { Text(request.text("details")).font(.caption.monospaced()).textSelection(.enabled) }
            Text("有效期至 " + Date(timeIntervalSince1970:(request["expiresAt"] as? Double ?? 0)/1000).formatted()).font(.caption).foregroundStyle(.secondary)
            if request.text("kind") == "approval" {
                HStack { Button("允许本次") { submit("approve",[:]) }; Button("拒绝",role:.destructive) { submit("deny",[:]) } }
            } else {
                ForEach(presentation.objects("questions"),id:\.self.textID) { question in
                    Text(question.text("prompt")).font(.headline)
                    ForEach(question.objects("options"),id:\.self.labelID) { option in
                        Button { answers[question.text("id")] = option.text("label") } label: {
                            VStack(alignment:.leading) { Text(option.text("label")); if !option.text("description").isEmpty { Text(option.text("description")).font(.caption).foregroundStyle(.secondary) } }
                    }
                    }
                    TextField("输入或补充回答",text:Binding(get:{answers[question.text("id")] ?? ""},set:{answers[question.text("id")]=$0}))
                }
                Button("提交回答") { submit("answer",answers) }.disabled(presentation.objects("questions").contains { (answers[$0.text("id")] ?? "").trimmingCharacters(in:.whitespacesAndNewlines).isEmpty })
            }
        }
    }
}

private struct NativeTaskCard: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channel: JSONObject
    let task: JSONObject
    private var currentChannel: JSONObject { store.runtime(projectID).objects("channels").first { $0.text("id") == channel.text("id") } ?? channel }
    private var currentTask: JSONObject { currentChannel.objects("tasks").first { $0.text("id") == task.text("id") } ?? task }
    @State private var confirmResend = false
    @State private var deliveryOverride: String?
    private var delivery: String { deliveryOverride ?? currentTask.text("delivery") }
    @State private var detail: JSONObject?
    private var current: Bool { currentChannel.object("current").text("taskId") == currentTask.text("id") }
    private var identity: JSONObject { ["routeId":projectID,"channelId":currentChannel.text("id"),"taskId":currentTask.text("id"),"archiveKey":task.text("archiveKey")] }
    private func act(_ action: String, request: String = "", answers: [String:String] = [:]) {
        Task {
            if await store.perform("api/tasks/control",identity.merging(["action":action,"requestId":request,"answers":answers]) { _,new in new }) != nil, action == "resend", !task.text("archiveKey").isEmpty {
                deliveryOverride = await store.perform("api/tasks/detail",identity)?.object("task").text("delivery")
            }
        }
    }
    private var execution: String {
        switch currentTask.text("execution") { case "completed": return "已完成"; case "interrupted": return "已中断"; case "failed": return "执行失败"; default:return currentChannel.object("current").text("phase","运行中") }
    }
    var body: some View {
        GroupBox {
            VStack(alignment:.leading,spacing:12) {
                HStack { Text(execution).font(.headline); Spacer(); Text(currentChannel.text("id")).foregroundStyle(.secondary); if current { Button("停止",role:.destructive) { act("stop") } } }
                Text(currentTask.text("input")).textSelection(.enabled)
                if !currentTask.text("reason").isEmpty { Text(currentTask.text("reason")).font(.caption).foregroundStyle(.secondary) }
                if current { ForEach(currentChannel.objects("requests"),id:\.self.textID) { request in
                    Divider()
                    NativeInteractionView(store:store,request:request) { action,answers in act(action,request:request.text("id"),answers:answers) }
                } }
                if !currentTask.text("result").isEmpty {
                    Divider(); Text(currentTask.text("result")).textSelection(.enabled)
                    HStack {
                        Text(currentTask.text("origin") == "desktop" ? "回复已保存在本机对话" : delivery == "sent" ? "渠道已接受结果" : delivery == "sending" ? "正在发送结果" : "结果已保存；发送尚未确认").font(.caption).foregroundStyle(.secondary)
                        if ["pending","uncertain"].contains(delivery) { Button("重新发送结果") { confirmResend=true } }
                    }
                }
                Button("查看完整任务") { Task { detail = await store.perform("api/tasks/detail",identity)?.object("task") } }
            }.padding(8).frame(maxWidth:.infinity,alignment:.leading)
        }
        .disabled(store.busy || !store.connected)
        .confirmationDialog("重新发送已保存的结果？上一次可能已有部分送达，本次不会重新执行任务。",isPresented:$confirmResend) { Button("重新发送") { act("resend") } }
        .sheet(isPresented:Binding(get:{detail != nil},set:{if !$0 {detail=nil}})) {
            VStack(alignment:.leading,spacing:16) {
                HStack { Text("完整任务").font(.title2); Spacer(); Button("完成") { detail=nil } }
                ScrollView { VStack(alignment:.leading,spacing:16) { Text("任务要求").font(.headline); Text(detail?.text("input") ?? ""); Divider(); Text("执行结果").font(.headline); Text(detail?.text("result","尚无结果") ?? "") }.textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading) }
            }.padding(24).frame(minWidth:600,minHeight:450)
        }
    }
}

private struct NativeTaskHistoryView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channelID: String
    @Environment(\.dismiss) private var dismiss
    @State private var tasks: [JSONObject] = []
    @State private var cursor: String?
    @State private var loaded=false
    private func load() async {
        var body: JSONObject = ["routeId":projectID,"channelId":channelID]
        if let cursor { body["cursor"]=cursor }
        if let result=await store.perform("api/tasks/history",body) { tasks += result.objects("tasks"); cursor=result["nextCursor"] as? String; loaded=true }
    }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack { Text("归档历史 · " + channelID).font(.title2); Spacer(); Button("完成") { dismiss() } }
            Text(store.notice).foregroundStyle(.secondary)
            ScrollView { LazyVStack(spacing:16) {
                ForEach(tasks,id:\.self.textID) { task in NativeTaskCard(store:store,projectID:projectID,channel:["id":channelID],task:task) }
                if loaded && tasks.isEmpty { Text("尚无归档任务").foregroundStyle(.secondary) }
                if cursor != nil || !loaded { Button(loaded ? "加载更多" : "加载历史") { Task { await load() } }.disabled(store.busy) }
            } }
        }.padding(24).frame(minWidth:650,minHeight:500).task { await load() }
    }
}

private extension Dictionary where Key == String, Value == Any {
    var textID: String { text("id") }
    var pathID: String { text("path") }
    var labelID: String { text("label") }
}

import SwiftUI

struct NativeConversationTurn: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    let channel: JSONObject
    let summary: JSONObject
    @State private var detail: JSONObject?
    @State private var error = ""
    @State private var expanded = false
    private var task: JSONObject { detail ?? summary }
    private var current: Bool { channel.object("current").text("taskId") == summary.text("id") }
    private var identity: JSONObject { ["routeId":projectID,"channelId":channel.text("id"),"taskId":summary.text("id"),"archiveKey":summary.text("archiveKey")] }
    private var revision: String { "\(summary["workflowRevision"] ?? 0):\(summary.text("execution")):\(summary.text("delivery"))" }
    private var workflow: [JSONObject] {
        if task["workflow"] != nil { return task.objects("workflow") }
        return channel.objects("activity").filter { $0.text("messageId") == summary.text("messageId") && !["received","sending","sent","response"].contains($0.text("stage")) }
    }
    private var events: [JSONObject] { workflow.filter { $0.text("stage") != "preview" } }
    private var previews: [JSONObject] {
        guard current || ["failed","interrupted"].contains(summary.text("execution")) else { return [] }
        let commentIDs = Set(workflow.filter { $0.text("stage") == "commentary" }.map { $0.text("itemId") })
        return workflow.filter { $0.text("stage") == "preview" && !commentIDs.contains($0.text("itemId")) }
    }
    private var status: String {
        if current { return channel.object("current").text("phase","等待后端活动") }
        return ["completed":"已完成","failed":"执行失败","interrupted":"已中断"][summary.text("execution")] ?? "等待状态更新"
    }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            HStack(alignment:.top) {
                Spacer(minLength:60)
                VStack(alignment:.leading,spacing:6) {
                    Text("你 · " + Date(timeIntervalSince1970:(task["startedAt"] as? Double ?? 0)/1000).formatted(date:.abbreviated,time:.shortened)).font(.caption).foregroundStyle(.secondary)
                    Text(task.text("input")).textSelection(.enabled)
                }.padding(14).background(Color.accentColor.opacity(0.09),in:RoundedRectangle(cornerRadius:14))
            }
            VStack(alignment:.leading,spacing:12) {
                HStack {
                    Label(task.text("backend","Agent").capitalized,systemImage:"sparkle").font(.headline)
                    Text(status).font(.caption).foregroundStyle(summary.text("execution") == "failed" ? .red : .secondary)
                    Spacer()
                    if current { Button("停止",role:.destructive) { act("stop") }.disabled(store.busy || !store.connected) }
                }
                if current {
                    TimelineView(.periodic(from:.now,by:1)) { timeline in
                        let latest = workflow.last?["at"] as? Double ?? task["startedAt"] as? Double ?? 0
                        let silence = max(0,Int(timeline.date.timeIntervalSince1970-latest/1000))
                        Text("最后活动距今 \(silence) 秒" + (silence >= 30 && channel.objects("requests").isEmpty ? " · 暂未收到后续事件" : ""))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !events.isEmpty {
                    DisclosureGroup(isExpanded:$expanded) {
                        VStack(alignment:.leading,spacing:10) {
                            if task["workflowTruncated"] as? Bool == true { Text("本轮过程较长，仅保留最近 1000 条事件。").font(.caption).foregroundStyle(.secondary) }
                            ForEach(events.indices,id:\.self) { i in
                                VStack(alignment:.leading,spacing:4) {
                                    Text((activityLabels[events[i].text("stage")] ?? events[i].text("stage")) + " · " + Date(timeIntervalSince1970:(events[i]["at"] as? Double ?? 0)/1000).formatted(date:.omitted,time:.standard)).font(.caption).foregroundStyle(.secondary)
                                    if !events[i].text("text").isEmpty { ConversationMarkdown(text:events[i].text("text")) }
                                }
                            }
                        }.padding(.top,8)
                    } label: { Text("工作过程 · \(events.count) 条活动").font(.callout) }
                } else if detail != nil && !current { Text("这条历史消息没有保存工作过程。").font(.caption).foregroundStyle(.secondary) }
                if !expanded, let commentary = events.last(where:{$0.text("stage") == "commentary"}) { ConversationMarkdown(text:commentary.text("text")) }
                ForEach(previews.indices,id:\.self) { i in ConversationMarkdown(text:previews[i].text("text")) }
                if current {
                    ForEach(channel.objects("requests").indices,id:\.self) { i in
                        let request = channel.objects("requests")[i]
                        GroupBox { NativeInteractionView(store:store,request:request) { action,answers in act(action,request:request.text("id"),answers:answers) }.frame(maxWidth:.infinity,alignment:.leading).padding(8) }
                            .disabled(store.busy || !store.connected)
                    }
                }
                if !task.text("result").isEmpty { ConversationMarkdown(text:task.text("result")) }
                if !task.text("reason").isEmpty { Text(task.text("reason")).foregroundStyle(.orange) }
                if !current && task.text("origin") != "desktop" && !task.text("result").isEmpty {
                    Text(summary.text("delivery") == "sent" ? "回复已交给消息渠道" : "回复已保存，渠道送达尚未确认；可在记录中处理。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if detail == nil && error.isEmpty { Text("正在读取完整消息…").font(.caption).foregroundStyle(.secondary) }
                if !error.isEmpty { HStack { Text(error).foregroundStyle(.red); Button("重试读取") { Task { await load() } } } }
            }.frame(maxWidth:.infinity,alignment:.leading)
            Divider()
        }
        .task(id:revision) { await load() }
        .onAppear { expanded = current }
    }
    private func load() async {
        do {
            let result = try await store.request("api/tasks/detail",body:identity)
            guard !Task.isCancelled else { return }
            detail=result.object("task"); error=""
        } catch { if !Task.isCancelled { self.error="完整消息暂时无法读取。" } }
    }
    private func act(_ action:String, request:String="", answers:[String:String]=[:]) {
        Task { await store.perform("api/tasks/control",identity.merging(["action":action,"requestId":request,"answers":answers]) { _,new in new }) }
    }
}

struct ConversationMarkdown: View {
    let text: String
    var body: some View {
        Text((try? AttributedString(markdown:text,options:.init(interpretedSyntax:.inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
            .textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
    }
}

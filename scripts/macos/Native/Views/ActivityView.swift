import SwiftUI

private struct Conversation: Identifiable {
    let id: String
    let channel: String
    let entries: [ActivityEntry]
    var input: ActivityEntry? { entries.first { ["received","scheduled"].contains($0.stage) } }
    var steps: [ActivityEntry] { entries.filter { !["received","scheduled","response","preview"].contains($0.stage) } }
    var responses: [ActivityEntry] {
        let final = entries.filter { $0.stage == "response" }
        return final.isEmpty ? Array(entries.filter { $0.stage == "preview" }.suffix(1)) : final
    }
}

struct NativeActivityView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    @State private var channelFilter = ""
    @State private var search = ""
    @State private var diagnostics = false
    private var all: [ActivityEntry] { store.activities(projectID).sorted { $0.date < $1.date } }
    private var conversations: [Conversation] {
        let groups = Dictionary(grouping:all.filter { !$0.value.text("messageId").isEmpty }) { $0.channel + ":" + $0.value.text("messageId") }
        return groups.map { Conversation(id:$0.key,channel:$0.value[0].channel,entries:$0.value) }
            .filter { (channelFilter.isEmpty || $0.channel == channelFilter) && (search.isEmpty || $0.entries.contains { ($0.label + $0.value.text("text")).localizedCaseInsensitiveContains(search) }) }
            .sorted { $0.entries[0].date < $1.entries[0].date }
    }
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Text("对话与活动").font(.title2.bold())
                Spacer()
                Toggle("诊断记录",isOn:$diagnostics).toggleStyle(.switch).controlSize(.small)
                Picker("入口",selection:$channelFilter) {
                    Text("全部入口").tag("")
                    ForEach(store.runtime(projectID).objects("channels").map{$0.text("id")},id:\.self) { Text($0).tag($0) }
                }.frame(maxWidth:220)
            }
            TextField("搜索对话或执行步骤",text:$search).textFieldStyle(.roundedBorder)
            Text("监看微信与 iMessage 对话 · 每 3 秒刷新 · 每个入口保留最近 200 条活动，重启后可回看。发送成功不代表已读。")
                .font(.caption).foregroundStyle(.secondary)
            if diagnostics {
                List(all.reversed().filter { channelFilter.isEmpty || $0.channel == channelFilter }) { entry in
                    DisclosureGroup(entry.label) { Text(entry.value.text("text","无文本详情")).textSelection(.enabled) }
                }
            } else if conversations.isEmpty {
                ContentUnavailableView("尚无对话",systemImage:"text.bubble",description:Text("从已绑定的微信或 iMessage 发来任务，或添加定时任务。消息到达后会显示在这里。"))
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment:.leading,spacing:28) {
                            ForEach(conversations) { conversation in
                                conversationView(conversation).id(conversation.id)
                            }
                            Color.clear.frame(height:1).id("bottom")
                        }.padding(.vertical,12).padding(.horizontal,4)
                    }
                    .onAppear { proxy.scrollTo("bottom",anchor:.bottom) }
                    .onChange(of:conversations.count) { _, _ in proxy.scrollTo("bottom",anchor:.bottom) }
                }
            }
        }.padding(20)
    }
    @ViewBuilder private func conversationView(_ conversation: Conversation) -> some View {
        let input = conversation.input
        let current = store.runtime(projectID).objects("channels").first { $0.text("id") == conversation.channel }?.object("current") ?? [:]
        let running = current.text("messageId") == conversation.entries[0].value.text("messageId")
        VStack(alignment:.leading,spacing:14) {
            HStack {
                Spacer(minLength:50)
                VStack(alignment:.trailing,spacing:6) {
                    Text((input?.stage == "scheduled" ? "定时任务" : "你") + " · " + conversation.channel).font(.caption).foregroundStyle(.secondary)
                    Text(input?.value.text("text") ?? "较早的消息已超出保留范围")
                        .textSelection(.enabled).padding(14).background(Color.accentColor.opacity(0.12),in:RoundedRectangle(cornerRadius:16)).frame(maxWidth:660,alignment:.trailing)
                    Text(conversation.entries[0].date,format:.dateTime.month().day().hour().minute().second()).font(.caption2).foregroundStyle(.secondary)
                }
            }
            VStack(alignment:.leading,spacing:10) {
                Label("Agent",systemImage:"sparkle").font(.headline)
                if running {
                    TimelineView(.periodic(from:.now,by:1)) { context in
                        let started = (current["startedAt"] as? Double ?? 0) / 1000
                        let phaseAt = (current["phaseAt"] as? Double ?? 0) / 1000
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(current.text("phase","等待后端活动") + " · 已用 \(max(0,Int(context.date.timeIntervalSince1970-started))) 秒 · 本阶段 \(max(0,Int(context.date.timeIntervalSince1970-phaseAt))) 秒")
                                .font(.callout).foregroundStyle(.secondary)
                        }
                    }
                }
                ForEach(conversation.responses) { entry in
                    VStack(alignment:.leading,spacing:6) {
                        if entry.stage == "preview" { Text(running ? "回复生成中" : "未完成的回复片段").font(.caption).foregroundStyle(.secondary) }
                        Text(entry.value.text("text")).textSelection(.enabled)
                    }.padding(14).frame(maxWidth:760,alignment:.leading).background(.quaternary,in:RoundedRectangle(cornerRadius:16))
                }
                if let outcome = conversation.steps.last(where:{["completed","failed","interrupted","schedule-skipped","busy","error","send-failed","stopped","backend-closed"].contains($0.stage)}) {
                    Text(outcome.value.text("text",outcome.label)).font(.callout).foregroundStyle(outcome.failed ? Color.red : Color.secondary).textSelection(.enabled)
                }
                if let sent = conversation.entries.last, sent.stage == "sent" { Label("渠道已接受回复",systemImage:"checkmark").font(.caption).foregroundStyle(.secondary) }
                DisclosureGroup("执行步骤（\(conversation.steps.count)）") {
                    VStack(alignment:.leading,spacing:12) {
                        ForEach(conversation.steps) { step in
                            HStack(alignment:.top,spacing:10) {
                                Text(step.date,format:.dateTime.hour().minute().second()).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                VStack(alignment:.leading,spacing:4) {
                                    Text(step.label).font(.callout.weight(.medium)).foregroundStyle(step.failed ? Color.red : Color.primary)
                                    if !step.value.text("text").isEmpty { Text(step.value.text("text")).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                                }
                            }
                        }
                    }.frame(maxWidth:.infinity,alignment:.leading).padding(.top,8)
                }.frame(maxWidth:800,alignment:.leading)
            }.frame(maxWidth:.infinity,alignment:.leading)
            Divider()
        }
    }
}

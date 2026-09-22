import SwiftUI

struct NativeConversationView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    @Binding var diagnostics: Bool
    @State private var channelID = ""
    @State private var selectedSession = ""
    @State private var draft = ""
    @State private var sending = false
    @State private var pendingMessageID: String?
    @State private var history: [JSONObject] = []
    @State private var cursor: String?
    @State private var historyFinished = false
    @State private var loading = false
    @State private var error = ""
    @State private var visibleCount = 30
    @State private var followLatest = true
    private var channels: [JSONObject] { store.runtime(projectID).objects("channels") }
    private var channel: JSONObject { channels.first { $0.text("id") == channelID } ?? channels.first ?? [:] }
    private var sessionID: String { selectedSession.isEmpty ? channel.text("sessionId") : selectedSession }
    private var scope: String { channel.text("id") + ":" + sessionID }
    private var sessions: [String] {
        let known = (channel["sessions"] as? [String] ?? []) + channel.objects("tasks").map { $0.text("sessionId") } + [channel.text("sessionId")]
        return Array(Set(known.filter { !$0.isEmpty })).sorted()
    }
    private var rows: [JSONObject] {
        let hot = channel.objects("tasks")
        let ids = Set(hot.map { $0.text("id") })
        return (hot + history.filter { !ids.contains($0.text("id")) }).filter {
            if let pendingMessageID, $0.text("messageId") == "desktop:" + pendingMessageID { return true }
            if selectedSession == "__new" { return false }
            return $0.text("sessionId") == (sessionID == "__legacy" ? "" : sessionID)
        }.sorted { ($0["startedAt"] as? Double ?? 0) < ($1["startedAt"] as? Double ?? 0) }
    }
    private func title(_ id: String) -> String {
        let first = channel.objects("tasks").filter { $0.text("sessionId") == id }.min { ($0["startedAt"] as? Double ?? 0) < ($1["startedAt"] as? Double ?? 0) }
        let text = first?.text("input").replacingOccurrences(of:"\n",with:" ") ?? ""
        return (id == channel.text("sessionId") ? "当前 · " : "") + (text.isEmpty ? String(id.prefix(16)) : String(text.prefix(30))) + " · " + String(id.prefix(6))
    }
    var body: some View {
        VStack(spacing:0) {
            HStack(spacing:12) {
                Picker("入口",selection:$channelID) {
                    if channelID.isEmpty { Text(channel.text("id","选择入口")).tag("") }
                    ForEach(channels.indices,id:\.self) { i in Text(channels[i].text("id")).tag(channels[i].text("id")) }
                }.frame(maxWidth:220).disabled(sending)
                Picker("会话",selection:$selectedSession) {
                    Text("当前会话").tag("")
                    Text("未关联会话的历史").tag("__legacy")
                    ForEach(sessions,id:\.self) { id in Text(title(id)).tag(id) }
                    if selectedSession == "__new" { Text("新对话").tag("__new") }
                }.frame(maxWidth:360).disabled(sending)
                Spacer()
                Button { selectedSession = "__new" } label: { Label("新对话",systemImage:"square.and.pencil") }.disabled(sending)
                Button("记录") { diagnostics = true }
            }.padding(16)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment:.leading,spacing:28) {
                        if rows.count > visibleCount || (!historyFinished && selectedSession != "__new") {
                            HStack { Spacer(); Button(loading ? "正在读取…" : "加载更早的消息") { Task { await older() } }.disabled(loading); Spacer() }
                        }
                        if rows.isEmpty {
                            ContentUnavailableView(selectedSession == "__new" ? "开始新对话" : "继续你的对话",systemImage:"bubble.left.and.bubble.right",description:Text("在下方发送消息，或从此入口发来消息。执行过程和回复会依次出现在这里。"))
                        }
                        ForEach(Array(rows.suffix(visibleCount).enumerated()),id:\.element.conversationID) { _, row in
                            NativeConversationTurn(store:store,projectID:projectID,channel:channel,summary:row)
                        }
                        Color.clear.frame(height:1).id("latest")
                    }.frame(maxWidth:900).frame(maxWidth:.infinity).padding(24)
                        .background {
                            GeometryReader { geometry in
                                ConversationScrollObserver(following:$followLatest)
                                    .preference(key:ConversationContentHeight.self,value:geometry.size.height)
                            }
                        }
                }
                .onPreferenceChange(ConversationContentHeight.self) { _ in
                    // Re-check after layout: the user may have scrolled since this was scheduled.
                    DispatchQueue.main.async {
                        if followLatest { proxy.scrollTo("latest",anchor:.bottom) }
                    }
                }
                .onChange(of: followLatest) { _,value in if value { proxy.scrollTo("latest",anchor:.bottom) } }
                .onAppear { followLatest = true; proxy.scrollTo("latest",anchor:.bottom) }
            }.id(scope)
            Divider()
            VStack(alignment:.leading,spacing:8) {
                if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                TextField("继续对话…",text:$draft,axis:.vertical).lineLimit(2...6).textFieldStyle(.plain)
                HStack {
                    Text(channel["busy"] as? Bool == true ? "Agent 正在回复，可在上方处理请求或停止。" : "桌面消息沿用所选会话，回复保存在这里。⌘ Return 发送")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if followLatest {
                        Text("跟随最新").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("回到最新") { followLatest = true }.font(.caption)
                    }
                    Button(sending ? "正在提交…" : "发送") { Task { await send() } }.keyboardShortcut(.return,modifiers:.command)
                        .disabled(sending || store.busy || !store.connected || channel.text("phase") != "listening" || channel["busy"] as? Bool == true || selectedSession == "__legacy" || draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                }
            }.padding(16)
        }
        .onChange(of: channelID) { _,_ in selectedSession = ""; pendingMessageID=nil; draft = "" }
        .onChange(of: scope) { _,_ in history=[]; cursor=nil; historyFinished=false; visibleCount=30; error="" }
    }
    private func older() async {
        followLatest = false
        if rows.count > visibleCount { visibleCount += 30; return }
        let requestedScope = scope
        loading=true; defer { loading=false }
        do {
            var body: JSONObject = ["routeId":projectID,"channelId":channel.text("id"),"sessionId":sessionID == "__legacy" ? "" : sessionID]
            if let cursor { body["cursor"]=cursor }
            let result = try await store.request("api/tasks/history",body:body)
            guard scope == requestedScope else { return }
            history += result.objects("tasks"); cursor=result["nextCursor"] as? String; historyFinished=cursor == nil
            visibleCount += 30; followLatest=false
        } catch { self.error = (error as? GatewayFailure)?.message ?? "无法读取历史，请重试。" }
    }
    private func send() async {
        let text = draft, requestedChannel = channel.text("id"), requestedSelection = selectedSession
        let messageID = UUID().uuidString
        pendingMessageID=messageID
        sending=true; error=""; defer { sending=false }
        var body: JSONObject = ["routeId":projectID,"channelId":channel.text("id"),"text":text,"messageId":messageID,"fresh":selectedSession == "__new"]
        if !sessionID.isEmpty && selectedSession != "__new" { body["sessionId"]=sessionID }
        do {
            _ = try await store.request("api/conversations/send",body:body)
            await store.refresh()
            if channel.text("id") == requestedChannel && selectedSession == requestedSelection { if draft == text { draft="" }; selectedSession=""; pendingMessageID=nil; followLatest=true }
        } catch { self.error = (error as? GatewayFailure)?.message ?? "提交状态未确认，请先查看对话中的执行状态，再决定是否重试。" }
    }
}

extension Dictionary where Key == String, Value == Any {
    var conversationID: String { text("id") }
}

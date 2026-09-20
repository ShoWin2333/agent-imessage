import SwiftUI

struct GatewayRootView: View {
    @ObservedObject var store: GatewayStore
    @State private var reloadConfirmation = false
    var body: some View {
        NavigationSplitView {
            List(selection:$store.selection) {
                Section("工作空间") {
                    ForEach(store.drafts) { draft in
                        ProjectRow(draft:draft,runtime:store.runtime(draft.id)).tag("project:" + draft.id)
                    }
                }
                Section {
                    Label("消息渠道",systemImage:"bubble.left.and.bubble.right").tag("channels")
                    Label("使用说明",systemImage:"questionmark.circle").tag("help")
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min:190,ideal:220,max:320)
            .safeAreaInset(edge:.bottom) {
                VStack(alignment:.leading,spacing:12) {
                    Button(action:store.addProject) { Label("添加项目",systemImage:"plus") }
                        .disabled(!store.connected || store.busy)
                    Label(store.connected ? "本机服务已连接" : "服务未连接",systemImage:store.connected ? "checkmark.circle" : "exclamationmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding().frame(maxWidth:.infinity,alignment:.leading)
            }
        } detail: {
            VStack(spacing:0) {
                if let id = store.selection, id.hasPrefix("project:"), let draft = store.drafts.first(where:{"project:" + $0.id == id}) {
                    NativeProjectView(store:store,draft:draft).id(draft.id)
                } else if store.selection == "channels" {
                    NativeChannelsView(store:store)
                } else if store.selection == "help" {
                    Form {
                        Section("从消息对话开始") {
                            Text("给绑定的 iMessage 号码或微信机器人发送文字任务。每个入口拥有独立的 Agent 会话。")
                            LabeledContent("/status",value:"查看当前状态")
                            LabeledContent("/new",value:"开始独立会话")
                            LabeledContent("/stop",value:"停止当前任务")
                            LabeledContent("/sessions",value:"列出当前入口的会话")
                            Text("审批和提问可在任务卡片或原对话中处理；先完成的操作生效。活动记录显示网关收到的消息和 Agent 提供的事件；不包含模型内部推理。")
                        }
                    }.formStyle(.grouped).navigationTitle("使用说明")
                } else {
                    ContentUnavailableView {
                        Label("连接你的第一个项目",systemImage:"bubble.left.and.bubble.right")
                    } description: { Text("选择 Agent 和本地工作目录，再绑定消息入口。") }
                    actions: { Button("添加项目",action:store.addProject).disabled(!store.connected) }
                }
                Divider()
                HStack {
                    if store.busy { ProgressView().controlSize(.small) }
                    Text(store.notice).font(.caption).textSelection(.enabled)
                    Spacer()
                }.padding(10)
            }
        }
        .toolbar {
            ToolbarItem {
                Button { reloadConfirmation = true } label: { Label("重新载入配置",systemImage:"arrow.clockwise") }
                    .help("重新载入配置会丢弃尚未保存的编辑")
                    .disabled(store.busy || !store.connected)
            }
        }
        .confirmationDialog("重新载入配置会丢弃所有未保存的编辑。",isPresented:$reloadConfirmation) {
            Button("重新载入",role:.destructive) { Task { await store.refresh(); if store.connected { store.reloadDrafts() } } }
        }
    }
}
private struct ProjectRow: View {
    @ObservedObject var draft: ProjectDraft
    let runtime: JSONObject
    private var status: String {
        if (runtime["pending"] as? Int ?? 0) > 0 { return "需要处理" }
        if runtime["busy"] as? Bool == true { return "正在执行" }
        if runtime.objects("channels").contains(where: { $0.objects("tasks").contains { !$0.text("result").isEmpty && ["pending","uncertain"].contains($0.text("delivery")) } }) { return "结果待发送" }
        return phaseName(runtime.text("phase"))
    }
    var body: some View {
        HStack {
            if let image = nativeImage(draft.value.text("avatar")) {
                Image(nsImage:image).resizable().scaledToFill().frame(width:24,height:24).clipShape(RoundedRectangle(cornerRadius:5))
            } else { Image(systemName:"folder") }
            VStack(alignment:.leading,spacing:2) {
                Text(draft.name + (draft.dirty ? " •" : ""))
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
func nativeImage(_ url: String) -> NSImage? {
    guard url.hasPrefix("data:image/"), let data = Data(base64Encoded:String(url.split(separator:",",maxSplits:1).last ?? "")) else { return nil }
    return NSImage(data:data)
}

import SwiftUI

struct NativeActivityView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    @State private var channelFilter = ""
    @State private var search = ""
    @State private var diagnostics = false
    private var all: [ActivityEntry] { store.activities(projectID).sorted { $0.date < $1.date } }
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Text("任务").font(.title2.bold())
                Spacer()
                Toggle("诊断记录",isOn:$diagnostics).toggleStyle(.switch).controlSize(.small)
                Picker("入口",selection:$channelFilter) {
                    Text("全部入口").tag("")
                    ForEach(store.runtime(projectID).objects("channels").map{$0.text("id")},id:\.self) { Text($0).tag($0) }
                }.frame(maxWidth:220)
            }
            TextField(diagnostics ? "搜索诊断记录" : "搜索最近任务摘要",text:$search).textFieldStyle(.roundedBorder)
            Text("任务与结果持久保存 · 每 3 秒刷新 · 诊断保留最近 200 条活动。发送成功不代表已读。")
                .font(.caption).foregroundStyle(.secondary)
            if diagnostics {
                List(all.reversed().filter { channelFilter.isEmpty || $0.channel == channelFilter }) { entry in
                    DisclosureGroup(entry.label) { Text(entry.value.text("text","无文本详情")).textSelection(.enabled) }
                }
            } else {
                NativeTasksView(store:store,projectID:projectID,channelFilter:channelFilter,search:search)
            }
        }.padding(20)
    }
}

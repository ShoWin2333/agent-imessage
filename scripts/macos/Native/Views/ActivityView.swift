import SwiftUI

struct NativeActivityView: View {
    @ObservedObject var store: GatewayStore
    let projectID: String
    @State private var diagnostics = false
    @State private var recordKind = "tasks"
    var body: some View {
        VStack(spacing:0) {
            if diagnostics {
                HStack { Text("诊断与任务记录").font(.headline); Spacer(); Button("返回对话") { diagnostics = false } }.padding()
                Picker("记录类型",selection:$recordKind) { Text("任务与归档").tag("tasks"); Text("最近诊断").tag("events") }.pickerStyle(.segmented).padding(.horizontal)
                if recordKind == "tasks" { NativeTasksView(store:store,projectID:projectID,channelFilter:"",search:"").padding() }
                else {
                    List(store.activities(projectID)) { entry in
                        DisclosureGroup(entry.channel + " · " + entry.label) { Text(entry.value.text("text","无文本详情")).textSelection(.enabled) }
                    }
                }
            } else {
                NativeConversationView(store:store,projectID:projectID,diagnostics:$diagnostics)
            }
        }
    }
}

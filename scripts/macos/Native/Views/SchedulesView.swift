import SwiftUI

struct NativeSchedulesView: View {
    @ObservedObject var store: GatewayStore
    @ObservedObject var draft: ProjectDraft
    private var tasks: [JSONObject] { draft.value.objects("schedules") }
    private func update(_ index: Int, _ key: String, _ value: Any) {
        var rows = tasks; guard rows.indices.contains(index) else { return }
        rows[index][key] = value; draft.value["schedules"] = rows; draft.dirty = true
    }
    private func field(_ index: Int, _ key: String) -> Binding<String> {
        Binding(get:{ tasks.indices.contains(index) ? tasks[index].text(key) : "" },set:{ update(index,key,$0) })
    }
    var body: some View {
        Form {
            Section {
                Text("到点后由本项目的 Agent 执行，并把结果发送到指定入口。适用于 Cursor、Codex 和 DSH。")
                Text("服务运行且电脑唤醒时有效；忙碌或断线时跳过，睡眠期间不补跑。任务沿用入口会话和审批设置。微信需先给机器人发过消息；会话凭据失效时需重新发消息。").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(tasks.indices,id:\.self) { index in
                Section {
                    TextField("任务名称",text:field(index,"name"))
                    Toggle("启用",isOn:Binding(get:{tasks.indices.contains(index) && tasks[index]["enabled"] as? Bool == true},set:{update(index,"enabled",$0)}))
                    Picker("回复到",selection:field(index,"channelId")) {
                        ForEach(draft.channels.map{$0.text("id")},id:\.self) { Text($0).tag($0) }
                    }
                    TextField("Cron 表达式",text:field(index,"cron"))
                    TextField("时区",text:field(index,"timeZone"))
                    Text(verbatim:"分 时 日 月 周 · 例如 0 9 * * 1-5：周一至周五 09:00；*/30 * * * *：每半小时。支持数字、*、逗号、范围和 / 步长。").font(.caption).foregroundStyle(.secondary)
                    Text("交给 Agent 的任务")
                    TextEditor(text:field(index,"prompt")).font(.body).frame(minHeight:100)
                    Button("删除任务",role:.destructive) {
                        var rows = tasks; rows.remove(at:index); draft.value["schedules"] = rows; draft.dirty = true
                    }
                } header: { Text(tasks[index].text("name","定时任务")) }
            }
            Section {
                Button("添加定时任务") {
                    var rows = tasks
                    rows.append(["id":"cron-" + UUID().uuidString.prefix(8).lowercased(),"name":"新任务","enabled":false,"channelId":draft.channels.first?.text("id") ?? "","cron":"0 9 * * *","timeZone":TimeZone.current.identifier,"prompt":""])
                    draft.value["schedules"] = rows; draft.dirty = true
                }.disabled(tasks.count >= 16 || draft.channels.isEmpty)
                Button("保存并应用项目") { Task { await store.save(draft) } }.buttonStyle(.borderedProminent)
                Text("任务默认停用。填写任务并启用后保存；保存会重启本项目的入口。执行结果和跳过原因可在「对话与活动」查看。").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).disabled(store.busy || !store.connected)
    }
}

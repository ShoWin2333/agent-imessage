import SwiftUI
import UniformTypeIdentifiers

struct NativeProjectView: View {
    @ObservedObject var store: GatewayStore
    @ObservedObject var draft: ProjectDraft
    @State private var tab = "activity"
    @State private var models: [JSONObject] = []
    @State private var removeConfirmation = false
    @State private var unrestrictedConfirmation = false
    @State private var chooseAvatar = false
    @State private var chooseDirectory = false
    var body: some View {
        VStack(spacing:0) {
            HStack {
                VStack(alignment:.leading,spacing:5) {
                    Text(draft.name).font(.title.bold())
                    Text(runtimeLabel).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Picker("项目页面",selection:$tab) {
                    Text("对话与活动").tag("activity")
                    Text("定时任务").tag("schedules")
                    Text("项目配置").tag("config")
                }.pickerStyle(.segmented).frame(width:340)
            }.padding(20)
            Divider()
            if tab == "activity" { NativeActivityView(store:store,projectID:draft.id) }
            else if tab == "schedules" { NativeSchedulesView(store:store,draft:draft) }
            else { configuration }
        }
        .navigationTitle(draft.name)
        .onAppear { if draft.dirty && draft.value.text("cwd").isEmpty { tab = "config" } }
        .confirmationDialog("移除项目不会影响其他项目。若本项目正在执行，请先停止任务。",isPresented:$removeConfirmation) {
            Button("移除项目",role:.destructive) { Task { await store.remove(draft) } }
        }
        .confirmationDialog("完全访问会关闭 Cursor 沙箱，执行时不再请求审批。确认允许访问当前用户可访问的文件和网络？",isPresented:$unrestrictedConfirmation) {
            Button("允许完全访问",role:.destructive) { draft.set("approvalPolicy","unrestricted") }
        }
        .fileImporter(isPresented:$chooseDirectory,allowedContentTypes:[.folder]) { result in
            if case .success(let url) = result { draft.set("cwd",url.path) }
        }
        .fileImporter(isPresented:$chooseAvatar,allowedContentTypes:[.jpeg,.png,.webP]) { result in
            if case .success(let url) = result { loadAvatar(url) }
        }
    }
    private var runtimeLabel: String {
        let runtime = store.runtime(draft.id)
        if runtime.isEmpty { return "项目尚未保存" }
        return runtime.objects("channels").map { channel in
            channel.text("id") + " · " + phaseName(channel.text("phase")) + " · " + (channel["busy"] as? Bool == true ? "任务运行中" : "空闲") + " · 待处理 \(channel["pending"] as? Int ?? 0)"
        }.joined(separator:"  /  ")
    }
    private func text(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get:{draft.value.text(key,fallback)},set:{draft.set(key,$0)})
    }
    private var configuration: some View {
        Form {
            Section("项目") {
                TextField("项目名称",text:text("label"))
                LabeledContent("路由 ID",value:draft.id)
                HStack { TextField("工作目录",text:text("cwd")); Button("选择…") { chooseDirectory = true } }
                HStack {
                    if let image = nativeImage(draft.value.text("avatar")) { Image(nsImage:image).resizable().frame(width:40,height:40).clipShape(RoundedRectangle(cornerRadius:8)) }
                    Button("上传头像") { chooseAvatar = true }
                    if draft.value["avatar"] != nil { Button("移除头像") { draft.set("avatar","") } }
                }
                Picker("Agent",selection:Binding(get:{draft.value.text("backend","codex")},set:{ value in
                    draft.set("backend",value); draft.set("model",""); draft.set("effort","default"); draft.set("speed","default"); draft.set("approvalPolicy","default"); models = []
                })) { Text("Codex").tag("codex"); Text("Cursor").tag("cursor"); Text("DSH").tag("dsh") }
                Toggle("随服务启用项目",isOn:Binding(get:{draft.value["enabled"] as? Bool ?? true},set:{draft.value["enabled"] = $0; draft.dirty = true}))
                    .disabled(draft.channels.isEmpty)
            }
            Section("模型与执行") {
                TextField("模型 ID（留空使用默认）",text:text("model"))
                HStack {
                    Button("刷新模型列表") { Task {
                        let backend = draft.value.text("backend","codex")
                        if let result = await store.perform("api/models",["backend":backend,"id":draft.id,"cwd":draft.value.text("cwd"),"model":draft.value.text("model")]), backend == draft.value.text("backend","codex") { models = result.objects("models") }
                    } }
                    if !models.isEmpty {
                        Menu("选择模型") {
                            Button("默认模型") { draft.set("model","") }
                            ForEach(models.indices,id:\.self) { index in
                                Button(models[index].text("name",models[index].text("id"))) { draft.set("model",models[index].text("id")); draft.set("effort","default"); draft.set("speed","default") }
                            }
                        }
                    }
                }
                Text("只显示模型已确认支持的选项。未读取能力时使用后端默认值。").font(.caption).foregroundStyle(.secondary)
                Picker("推理强度",selection:text("effort",fallback:"default")) {
                    ForEach(parameterChoices("efforts",fallback:[]),id:\.self) { Text(parameterLabel($0)).tag($0) }
                }
                Picker("速度",selection:text("speed",fallback:"default")) {
                    ForEach(parameterChoices("speeds",fallback:[]),id:\.self) { Text(parameterLabel($0)).tag($0) }
                }
                Picker("审批权限",selection:Binding(get:{draft.value.text("approvalPolicy","default")},set:{ if $0 == "unrestricted" { unrestrictedConfirmation = true } else { draft.set("approvalPolicy",$0) } })) {
                    ForEach(policies,id:\.0) { Text($0.1).tag($0.0) }
                }
                if draft.value.text("backend") == "cursor" {
                    Picker("项目规则",selection:text("cursorSettings",fallback:"project")) {
                        Text("加载项目规则").tag("project"); Text("项目与用户规则").tag("project-user"); Text("不加载本地规则").tag("none")
                    }
                    Picker("模式",selection:text("cursorMode",fallback:"agent")) {
                        Text("Agent").tag("agent"); Text("Plan").tag("plan"); Text("Ask").tag("ask")
                    }
                } else { Text("项目规则由所选 Agent 原生加载。").font(.caption).foregroundStyle(.secondary) }
            }
            Section("消息入口") { ProjectChannelEditor(store:store,draft:draft) }
            Section {
                HStack {
                    Button("保存并应用项目") { Task { await store.save(draft) } }.buttonStyle(.borderedProminent)
                    Spacer()
                    Button("移除项目",role:.destructive) { removeConfirmation = true }
                }
                Text("名称、头像和计划立即生效；模型参数下次任务生效；目录、权限和入口变更请先停止任务。").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).disabled(store.busy || !store.connected)
    }
    private func parameterChoices(_ key: String, fallback: [String]) -> [String] {
        let model = models.first { $0.text("id") == draft.value.text("model") }
        let choices = model.map { $0.objects(key).map { $0.text("value") } } ?? fallback
        let current = draft.value.text(key == "efforts" ? "effort" : "speed","default")
        return ["default"] + Array(Set(choices + (current == "default" ? [] : [current]))).sorted()
    }
    private func parameterLabel(_ value: String) -> String {
        if value == "default" { return "默认" }
        let model = models.first { $0.text("id") == draft.value.text("model") }
        let known = (model?.objects("efforts") ?? []) + (model?.objects("speeds") ?? [])
        return known.contains { $0.text("value") == value } ? value : value + "（已保存，能力未确认）"
    }
    private var policies: [(String,String)] {
        switch draft.value.text("backend","codex") {
        case "cursor": return [("default","沙箱内执行"),("auto-review","沙箱 + Cursor 自动审核"),("unrestricted","完全访问：关闭沙箱，不请求审批")]
        case "dsh": return [("default","通过原对话审批"),("deny","拒绝所有额外权限请求")]
        default: return [("default","沙箱内执行，额外权限人工审批"),("on-request","按需人工审批"),("auto-review","沙箱 + Codex 自动审核"),("never","不请求审批，超出沙箱则拒绝")]
        }
    }
    private func loadAvatar(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf:url), data.count <= 8 * 1024 * 1024, let image = NSImage(data:data), image.size.width > 0, image.size.height > 0 else { store.notice = "请选择不超过 8 MB 的有效图片。"; return }
        let thumbnail = NSImage(size:NSSize(width:128,height:128))
        thumbnail.lockFocus()
        NSColor.white.setFill(); NSRect(x:0,y:0,width:128,height:128).fill()
        let side = min(image.size.width,image.size.height)
        image.draw(in:NSRect(x:0,y:0,width:128,height:128),from:NSRect(x:(image.size.width-side)/2,y:(image.size.height-side)/2,width:side,height:side),operation:.sourceOver,fraction:1)
        thumbnail.unlockFocus()
        guard let tiff = thumbnail.tiffRepresentation, let bitmap = NSBitmapImageRep(data:tiff) else { return }
        for quality in [0.8,0.6,0.4] {
            if let jpeg = bitmap.representation(using:.jpeg,properties:[.compressionFactor:quality]) {
                let value = "data:image/jpeg;base64," + jpeg.base64EncodedString()
                if value.count <= 16000 { draft.set("avatar",value); return }
            }
        }
        store.notice = "图片处理失败，请选择更简单的图片。"
    }
}

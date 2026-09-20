import SwiftUI

@MainActor final class GatewayStore: ObservableObject {
    @Published var state: JSONObject = [:]
    @Published var drafts: [ProjectDraft] = []
    @Published var connected = false
    @Published var busy = false
    @Published var notice = "正在连接本机服务…"
    @Published var selection: String? = nil
    private(set) var baseURL: URL
    private var editorRevision: Int?
    private var polling: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private let session: URLSession
    init(url: URL, session: URLSession = .shared) { baseURL = url; self.session = session }
    func start(url: URL) {
        baseURL = url
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                if let self, !self.busy { await self.refresh() }
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
    }
    func stop() { polling?.cancel(); polling = nil }
    func refresh() async {
        if let refreshTask { await refreshTask.value; return }
        let task = Task { @MainActor in
            defer { self.refreshTask = nil }
            do {
                let result = try await self.request("api/state")
                self.state = result; self.connected = true
                if self.editorRevision == nil {
                    self.reloadDrafts(); self.notice = "已连接本机服务"
                }
            } catch { self.connected = false; self.notice = "本机服务未连接，请使用菜单中的重新连接。" }
        }
        refreshTask = task
        await task.value
    }
    func reloadDrafts() {
        drafts = state.object("config").objects("routes").map(ProjectDraft.init)
        editorRevision = state["revision"] as? Int
        if selection == nil || (selection?.hasPrefix("project:") == true && !drafts.contains(where: { "project:" + $0.id == selection })) {
            selection = drafts.first.map { "project:" + $0.id }
        }
    }
    func addProject() {
        let id = "project-" + UUID().uuidString.prefix(8).lowercased()
        let draft = ProjectDraft(["id":id,"label":"新项目","cwd":"","backend":"codex","channels":[JSONObject](),"enabled":false])
        draft.dirty = true; drafts.append(draft); selection = "project:" + id
    }
    func runtime(_ id: String) -> JSONObject { state.objects("routes").first { $0.text("id") == id } ?? [:] }
    func activities(_ id: String) -> [ActivityEntry] {
        runtime(id).objects("channels").flatMap { channel in
            channel.objects("activity").map { ActivityEntry(channel:channel.text("id"),kind:channel.text("kind"),value:$0) }
        }.sorted { $0.date > $1.date || ($0.date == $1.date && ($0.value["sequence"] as? Int ?? 0) > ($1.value["sequence"] as? Int ?? 0)) }
    }
    private func request(_ path: String, body: JSONObject? = nil) async throws -> JSONObject {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.timeoutInterval = body == nil ? 5 : 120
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField:"Content-Type")
            let origin = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn:"/"))
            request.setValue(origin, forHTTPHeaderField:"Origin")
            request.setValue(state.text("csrf"), forHTTPHeaderField:"x-agent-token")
            request.httpBody = try JSONSerialization.data(withJSONObject:body)
        }
        let (data, response) = try await session.data(for:request)
        guard let response = response as? HTTPURLResponse else { throw GatewayFailure(message:"本机服务响应无效。") }
        let result = (try? JSONSerialization.jsonObject(with:data)) as? JSONObject ?? [:]
        guard (200..<300).contains(response.statusCode) else {
            throw GatewayFailure(message: response.statusCode == 409 ? "配置已在其他窗口变更。请先保留未保存的内容，再重新载入配置。" : result.text("error", "操作失败，请检查配置和连接。"))
        }
        return result
    }
    @discardableResult func perform(_ path: String, _ body: JSONObject = [:]) async -> JSONObject? {
        guard !busy, connected else { return nil }
        busy = true
        defer { busy = false }
        do {
            let result = try await request(path, body:body)
            if let refreshTask { await refreshTask.value }
            await refresh(); notice = connected ? "操作完成" : "操作已提交，暂时无法刷新状态。"
            return result
        } catch { notice = (error as? GatewayFailure)?.message ?? "请求失败，请检查本机服务连接。"; return nil }
    }
    func save(_ draft: ProjectDraft) async {
        guard let revision = editorRevision else { return }
        let body: JSONObject = ["revision":revision,"id":draft.id,"route":draft.value,"photon":draft.secrets]
        if await perform("api/save-route",body) != nil {
            editorRevision = revision + 1
            draft.secrets = [:]; draft.dirty = false
            notice = "项目已保存并应用"
        }
    }
    func remove(_ draft: ProjectDraft) async {
        guard let revision = editorRevision else { return }
        var config = state.object("config")
        config["routes"] = config.objects("routes").filter { $0.text("id") != draft.id }
        if await perform("api/save",["revision":revision,"config":config]) != nil {
            editorRevision = revision + 1
            drafts.removeAll { $0.id == draft.id }; selection = drafts.first.map { "project:" + $0.id }
        }
    }
    func saveKey(_ key: String) async -> Bool {
        guard let revision = editorRevision else { return false }
        if await perform("api/save",["revision":revision,"config":state.object("config"),"cursorApiKey":key]) != nil {
            editorRevision = revision + 1; return true
        }
        return false
    }
}
struct GatewayFailure: Error { let message: String }

import Foundation
import Combine

typealias JSONObject = [String: Any]
extension Dictionary where Key == String, Value == Any {
    func text(_ key: String, _ fallback: String = "") -> String { self[key] as? String ?? fallback }
    func objects(_ key: String) -> [JSONObject] { self[key] as? [JSONObject] ?? [] }
    func object(_ key: String) -> JSONObject { self[key] as? JSONObject ?? [:] }
}

final class ProjectDraft: ObservableObject, Identifiable {
    let id: String
    @Published var value: JSONObject
    @Published var secrets: [String: String] = [:]
    @Published var dirty = false
    init(_ value: JSONObject) { self.id = value.text("id"); self.value = value }
    var name: String { value.text("label").isEmpty ? id : value.text("label") }
    var channels: [JSONObject] {
        if let channels = value["channels"] as? [JSONObject] { return channels }
        return [["id":"imessage", "kind":"imessage", "projectId":value.text("projectId"),
                 "projectSecretEnv":value.text("projectSecretEnv"), "senderPhoneNumber":value.text("senderPhoneNumber"),
                 "assignedPhoneNumber":value.text("assignedPhoneNumber")]]
    }
    func setChannels(_ channels: [JSONObject]) {
        value["channels"] = channels
        if channels.isEmpty { value["enabled"] = false }
        dirty = true
    }
    func set(_ key: String, _ text: String) {
        if text.isEmpty && ["model","avatar","cursorApiKeyEnv"].contains(key) { value.removeValue(forKey: key) }
        else { value[key] = text }
        dirty = true
    }
}

struct ActivityEntry: Identifiable {
    let channel: String
    let kind: String
    let value: JSONObject
    var id: String { channel + ":" + String(value["sequence"] as? Int ?? 0) }
    var stage: String { value.text("stage") }
    var date: Date { Date(timeIntervalSince1970: (value["at"] as? Double ?? 0) / 1000) }
    var label: String { activityLabels[stage] ?? stage }
    var failed: Bool { ["error","failed","send-failed","media-failed","unavailable","backend-closed"].contains(stage) }
}
let activityLabels = [
"session-ready":"会话就绪","run-created":"运行已创建，等待模型活动","model-active":"模型返回活动","generating":"开始生成回复","tool-running":"正在执行工具","tool-completed":"工具执行完成","tool-failed":"工具报告错误","preview":"回复生成中","scheduled":"定时任务触发","schedule-skipped":"定时任务已跳过",
    "connected":"渠道已连接", "disconnected":"渠道断开", "received":"网关收到消息", "unavailable":"未处理：连接不可用",
    "duplicate":"重复消息已忽略", "opening-session":"正在建立 Agent 会话", "submitting":"正在提交任务",
    "started":"适配器已接单", "accepted":"适配器已接单", "response":"Agent 返回文本", "changes":"Agent 报告文件变化",
    "request":"Agent 请求", "waiting-approval":"等待审批", "waiting-answer":"等待回答", "interaction-resolved":"已收到审批／回答",
    "interaction-cancelled":"审批／提问取消或超时", "completed":"Agent 已完成", "interrupted":"任务已中断", "failed":"Agent 执行失败",
    "error":"处理失败", "busy":"未执行：已有任务运行", "sending":"正在发送回复", "sent":"渠道接口返回成功",
    "send-failed":"回复发送失败", "media-failed":"附件读取或发送失败", "backend-closed":"Agent 连接已关闭", "stopped":"路线已停止"
]
func phaseName(_ value: String) -> String {
    ["listening":"已连接", "stopped":"已停止", "starting":"启动中", "connecting":"连接中", "failed":"连接失败",
     "retrying":"正在重试", "reconnecting":"重新连接中"][value] ?? value
}

/// Validate owner identity before a token-bearing network request is submitted.
enum TelegramFormValidation {
    static func ownerError(_ input: String) -> String? {
        let value = input.trimmingCharacters(in:.whitespacesAndNewlines)
        guard value.range(of:"^[1-9][0-9]{0,15}$",options:.regularExpression) != nil,
              let number = UInt64(value), number <= 9_007_199_254_740_991 else {
            return "请填写你本人的纯数字 Telegram 用户 ID，例如 123456789；不能填写 @用户名、手机号或 Bot ID。"
        }
        return nil
    }
}

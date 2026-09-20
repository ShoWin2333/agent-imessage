import SwiftUI

struct NativeScheduleTiming: View {
    @ObservedObject var store: GatewayStore
    @Binding var cron: String
    @Binding var zone: String
    let schedule: JSONObject
    @State private var mode = "advanced"
    @State private var hour = 9
    @State private var minute = 0
    @State private var weekday = 1
    @State private var runs: [Double] = []
    @State private var previewed = ""
    private func apply() {
        guard mode != "advanced" else { return }
        let value = "\(minute) \(hour) * * " + (mode == "daily" ? "*" : mode == "weekdays" ? "1-5" : "\(weekday)")
        if cron != value { cron = value }
    }
    private func inferMode() {
            let parts = cron.split(separator:" ").map(String.init)
            if parts.count == 5, let m = Int(parts[0]), let h = Int(parts[1]), parts[2] == "*", parts[3] == "*" {
                hour = h; minute = m
                if parts[4] == "*" { mode = "daily" }
                else if parts[4] == "1-5" { mode = "weekdays" }
                else if let d = Int(parts[4]), (0...6).contains(d) { weekday = d; mode = "weekly" }
            }
    }
    var body: some View {
        Picker("重复", selection:$mode) {
            Text("每天").tag("daily")
            Text("工作日").tag("weekdays")
            Text("每周").tag("weekly")
            Text("高级 Cron").tag("advanced")
        }.onChange(of:mode) { _, _ in apply() }.onAppear { inferMode() }
        if mode == "advanced" {
            TextField("Cron 表达式",text:$cron)
            Text("分 时 日 月 周；支持数字、*、逗号、范围和步长。").font(.caption).foregroundStyle(.secondary)
        } else {
            HStack {
                Picker("时",selection:$hour) { ForEach(0..<24,id:\.self) { Text(String(format:"%02d",$0)).tag($0) } }
                Picker("分",selection:$minute) { ForEach(0..<60,id:\.self) { Text(String(format:"%02d",$0)).tag($0) } }
            }.onChange(of:hour) { _, _ in apply() }.onChange(of:minute) { _, _ in apply() }
            if mode == "weekly" {
                Picker("星期",selection:$weekday) {
                    ForEach(0..<7,id:\.self) { Text(["日","一","二","三","四","五","六"][$0]).tag($0) }
                }.onChange(of:weekday) { _, _ in apply() }
            }
        }
        TextField("时区",text:$zone)
        Button("预览未来五次执行") {
            Task {
                var value = schedule
                value["cron"] = cron; value["timeZone"] = zone
                if value.text("prompt").isEmpty { value["prompt"] = "预览" }
                if let result = await store.perform("api/schedules/preview",["schedule":value]) {
                    runs = result["runs"] as? [Double] ?? []
                    previewed = cron + zone
                }
            }
        }
        if previewed == cron + zone {
            VStack(alignment:.leading,spacing:4) {
            ForEach(runs,id:\.self) { time in
                Text(Date(timeIntervalSince1970:time/1000).formatted(Date.FormatStyle(date:.abbreviated,time:.shortened).locale(Locale(identifier:"zh_CN")).withZone(zone)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            }
            if runs.isEmpty && !previewed.isEmpty { Text("未来一年内没有执行时间，请检查计划。").foregroundStyle(.orange) }
        }

    }
}

private extension Date.FormatStyle {
    func withZone(_ identifier: String) -> Date.FormatStyle {
        var style = self
        style.timeZone = TimeZone(identifier:identifier) ?? .current
        return style
    }
}

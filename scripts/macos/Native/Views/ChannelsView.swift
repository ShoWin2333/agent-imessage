import SwiftUI

struct NativeChannelsView: View {
    @ObservedObject var store: GatewayStore
    @State private var verificationCode = ""
    var body: some View {
        Form {
            TelegramChannelsView(store: store)
            Section("WeChat · 个人微信") {
                let login = store.state.object("weixinLogin")
                Text(login.text("error",loginStatus(login.text("phase"))))
                ForEach(store.state.objects("weixinAccounts").map{$0.text("accountId")},id:\.self) { id in
                    VStack(alignment:.leading,spacing:6) {
                        Text(id).font(.caption).textSelection(.enabled)
                        ChannelAccountBinding(store:store,kind:"weixin",accountID:id)
                    }
                }
                if let image = nativeImage(login.text("qr")) {
                    Image(nsImage:image).interpolation(.none).resizable().scaledToFit().frame(width:240,height:240)
                        .accessibilityLabel("使用个人微信扫描此二维码绑定机器人")
                }
                HStack {
                    Button("添加微信机器人（扫码）") { Task { await store.perform("api/weixin/begin") } }
                    Button("取消扫码") { Task { await store.perform("api/weixin/cancel") } }
                }
                if login.text("phase") == "needs_verification" {
                    TextField("微信配对码",text:$verificationCode)
                    Button("提交配对码") { Task { if await store.perform("api/weixin/verify",["id":login.text("id"),"code":verificationCode]) != nil { verificationCode = "" } } }
                }
                Text("扫码添加账号后，在 Agent 的消息入口中选择绑定。只接受扫码者的私聊消息。").foregroundStyle(.secondary)
            }
            Section("iMessage · Photon") {
                let authorization = store.state.object("authorization")
                Text(photonStatus(authorization.text("phase")))
                if authorization.text("phase") == "pending" {
                    LabeledContent("验证码",value:authorization.text("userCode")).textSelection(.enabled)
                    if let url = URL(string:authorization.text("verificationUri")), url.scheme == "https" || url.scheme == "http" {
                        Link("打开 Photon 授权页面",destination:url)
                    }
                }
                HStack {
                    Button("授权 Photon") { Task { await store.perform("api/photon/authorize") } }
                    Button("取消授权") { Task { await store.perform("api/photon/cancel") } }
                }
                PhotonChannelsView(store:store)
            }
        }.formStyle(.grouped).navigationTitle("消息渠道").disabled(store.busy || !store.connected)
    }
    private func loginStatus(_ phase: String) -> String {
        ["idle":"用个人微信扫码添加机器人。","pending":"请用微信扫描二维码。","scanned":"已扫码，请在微信确认。","needs_verification":"请填写微信显示的配对码。","connected":"账号已添加，请在 Agent 的消息入口选择机器人并保存。","expired":"二维码已过期，请重新生成。","failed":"绑定失败，请重试。","cancelled":"已取消扫码。"][phase] ?? phase
    }
    private func photonStatus(_ phase: String) -> String {
        ["authorized":"已授权，可以管理项目号码。","pending":"请打开授权页面并输入验证码。","disconnected":"尚未授权项目管理；不影响已有线路收发。","reauthorization-required":"管理授权已过期，请重新授权。","failed":"授权失败，请重试。"][phase] ?? phase
    }
}

struct NativeSettingsView: View {
    @ObservedObject var store: GatewayStore
    @State private var apiKey = ""
    @State private var stopConfirmation = false
    var body: some View {
        Form {
            Section("Cursor SDK 凭据") {
                Text(store.state["hasCursorKey"] as? Bool == true ? "已配置 API Key；留空保留现有凭据。" : "尚未配置，也可使用 CURSOR_API_KEY 环境变量。")
                SecureField("API Key",text:$apiKey)
                Button("保存凭据") { Task { if await store.saveKey(apiKey) { apiKey = "" } } }.disabled(apiKey.isEmpty)
                Text("仅更新 Cursor 项目；如有 Cursor 任务运行，请先停止。密钥保存在本机私有配置中，不会回显。").font(.caption).foregroundStyle(.secondary)
            }
            Section("常驻与登录启动") {
                Text("关闭窗口后 App 继续运行；退出 App 后，自有服务停止。登录启动是独立设置。")
                Link("打开系统登录项设置",destination:URL(string:"x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!)
                Text("在系统设置中将 Agent iMessage 加入登录时打开。本 App 不会自动注册登录项。").font(.caption).foregroundStyle(.secondary)
            }
            Section("本机服务") {
                HStack {
                    Button("启动 / 重试全部路线") { Task { await store.perform("api/start") } }
                    Button("停止全部路线",role:.destructive) { stopConfirmation = true }
                }
            }
            Section { Text(store.notice).font(.caption).textSelection(.enabled) }
        }.formStyle(.grouped).frame(width:540,height:540).disabled(store.busy || !store.connected)
        .confirmationDialog("停止全部路线会取消正在运行的任务。",isPresented:$stopConfirmation) {
            Button("停止全部路线",role:.destructive) { Task { await store.perform("api/stop") } }
        }
    }
}

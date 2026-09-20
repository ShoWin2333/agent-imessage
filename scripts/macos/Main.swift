import Cocoa
import SwiftUI

// Resident desktop app; the management window is independent of service lifetime.
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    @MainActor lazy var gatewayStore = GatewayStore(url: url)
    var settingsWindow: NSWindow?
    var ownsService = false
    var closing = false
    let serviceQueue = DispatchQueue(label: "app.agent-imessage.service")
    lazy var service = GatewayService(label: serviceTarget, directory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Agent iMessage/Desktop"))
    var target: String { service.target }
    var statusItem: NSStatusItem!
    var statusLine: NSMenuItem!
    var reconnectItem: NSMenuItem!
    var statusTimer: Timer?
    var checkingStatus = false

    var starting = false
    var pollGeneration = 0
    var serviceTarget: String { Bundle.main.object(forInfoDictionaryKey: "GatewayServiceLabel") as? String ?? "app.agent-imessage.gateway" }
    var standaloneURL: URL?
    var url: URL { if let resolved = standaloneURL { return resolved }; return URL(string: Bundle.main.object(forInfoDictionaryKey: "GatewayURL") as? String ?? "http://127.0.0.1:8787/")! }

    // Runtime paths are resolved after installation, so moving the bundle is safe.
    // Keep existing user data outside the bundle; never package credentials.
    func serviceJob() throws -> [String: Any] {
        let resources = Bundle.main.resourceURL!
        guard Bundle.main.object(forInfoDictionaryKey: "GatewayStandalone") as? Bool == true else {
            let data = try Data(contentsOf: resources.appendingPathComponent("gateway.plist"))
            return try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: Any]
        }
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser
        let config = ProcessInfo.processInfo.environment["AGENT_GATEWAY_CONFIG"].map { URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent(".config/agent-imessage/config.json")
        var port = 8787
        if fm.fileExists(atPath: config.path) {
            let json = try JSONSerialization.jsonObject(with: Data(contentsOf: config)) as? [String: Any]
            if let configured = json?["port"] {
                guard let number = configured as? NSNumber,
                      CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue == Double(number.intValue), (1...65535).contains(number.intValue) else {
                    throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "配置中的端口必须是 1–65535 的固定端口。"])
                }
                port = number.intValue
            }
        }
        standaloneURL = URL(string: "http://127.0.0.1:\(port)/")!
        let runtime = home.appendingPathComponent("Library/Application Support/Agent iMessage/Desktop")
        try fm.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtime.path)
        let helpers = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers")
        let payload = resources.appendingPathComponent("gateway")
        var searchPaths = [helpers.path, home.appendingPathComponent(".local/bin").path,
                           home.appendingPathComponent(".npm-global/bin").path,
                           "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        // Finder launches do not inherit a shell PATH. Codex may be installed
        // as a desktop app only; discover its actual location through Launch Services.
        if let codexApp = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") {
            let directory = codexApp.appendingPathComponent("Contents/Resources")
            if fm.isExecutableFile(atPath: directory.appendingPathComponent("codex").path) {
                searchPaths.append(directory.path)
            }
        }
        let environment = [
            "HOME": home.path,
            "PATH": searchPaths.joined(separator: ":")
        ]
        let job: [String: Any] = [
            "Label": serviceTarget,
            "ProgramArguments": [helpers.appendingPathComponent("node").path, payload.appendingPathComponent("lib/types/app/cli.js").path, "start", config.path],
            "WorkingDirectory": home.path, "EnvironmentVariables": environment,
            "RunAtLoad": true, "KeepAlive": true, "ThrottleInterval": 10,
            "StandardOutPath": runtime.appendingPathComponent("gateway.log").path,
            "StandardErrorPath": runtime.appendingPathComponent("gateway.log").path
        ]
        return job
    }

    @discardableResult func launchctl(_ args: [String]) -> Int32 { GatewayService.command(args).0 }

    func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        statusLine = menu.addItem(withTitle: "正在启动…", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "打开管理界面", action: #selector(showWindow), keyEquivalent: "").target = self
        reconnectItem = menu.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "")
        reconnectItem.target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出 Agent iMessage", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
        setStatus("正在启动…", symbol: "bubble.left.and.bubble.right")
        statusTimer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in self?.refreshStatus() }
        RunLoop.main.add(statusTimer!, forMode: .common)
    }
    func setStatus(_ text: String, symbol: String) {
        statusLine.title = text
        if statusItem.button?.image == nil {
            // A single speech-bubble silhouette echoes the app artwork. Template
            // rendering lets macOS choose white/black for the menu bar material.
            let icon = NSImage(size: NSSize(width: 20, height: 18), flipped: false) { _ in
                let bubble = NSBezierPath()
                bubble.move(to: NSPoint(x: 6, y: 5))
                bubble.curve(to: NSPoint(x: 1, y: 10), controlPoint1: NSPoint(x: 3, y: 6), controlPoint2: NSPoint(x: 1, y: 7))
                bubble.curve(to: NSPoint(x: 10, y: 17), controlPoint1: NSPoint(x: 1, y: 14), controlPoint2: NSPoint(x: 5, y: 17))
                bubble.curve(to: NSPoint(x: 19, y: 10), controlPoint1: NSPoint(x: 15, y: 17), controlPoint2: NSPoint(x: 19, y: 14))
                bubble.curve(to: NSPoint(x: 10, y: 3), controlPoint1: NSPoint(x: 19, y: 6), controlPoint2: NSPoint(x: 15, y: 3))
                bubble.curve(to: NSPoint(x: 3, y: 1), controlPoint1: NSPoint(x: 7, y: 3), controlPoint2: NSPoint(x: 5, y: 1))
                bubble.curve(to: NSPoint(x: 6, y: 5), controlPoint1: NSPoint(x: 4, y: 2), controlPoint2: NSPoint(x: 5, y: 4))
                bubble.close()
                NSColor.black.setFill()
                bubble.fill()
                return true
            }
            icon.isTemplate = true
            statusItem.button?.image = icon
        }
        statusLine.image = symbol == "exclamationmark.bubble" ? NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: "需要检查") : nil
        statusItem.button?.toolTip = "Agent iMessage · " + text
        reconnectItem.isEnabled = !starting && !closing
    }
    @objc func showWindow() {
        guard !closing else { return }
        NSApp.setActivationPolicy(.regular)
        window.deminiaturize(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    func windowWillClose(_ notification: Notification) {
        // Keep the menu bar entry while removing the now-empty Dock presence.
        if !closing { NSApp.setActivationPolicy(.accessory) }
    }
    func refreshStatus() {
        guard !closing && !starting && !checkingStatus else { return }
        checkingStatus = true
        var request = URLRequest(url: url.appendingPathComponent("api/state"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, response, _ in
            DispatchQueue.main.async {
                self.checkingStatus = false
                guard !self.closing && !self.starting else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let routes = state["routes"] as? [[String: Any]] else {
                    self.setStatus("服务未连接 · 可重新连接", symbol: "exclamationmark.bubble")
                    self.window.subtitle = "服务未连接 · 菜单栏可重新连接"
                    return
                }
                let failed = routes.filter { $0["phase"] as? String == "failed" }.count
                let busy = routes.filter { $0["busy"] as? Bool == true }.count
                let text = failed > 0 ? "\(failed) 个工作空间需要检查" : busy > 0 ? "\(busy) 个工作空间正在处理" : "服务已连接 · \(routes.count) 个工作空间"
                self.setStatus(text, symbol: failed > 0 ? "exclamationmark.bubble" : "bubble.left.and.bubble.right")
                self.window.subtitle = ""
            }
        }.resume()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set the running Dock icon explicitly; Launch Services can retain the
        // generic icon when a local app bundle is updated in place.
        if let iconFile = Bundle.main.object(forInfoDictionaryKey: "CFBundleIconFile") as? String,
           let iconURL = Bundle.main.resourceURL?.appendingPathComponent(iconFile),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: ",").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Agent iMessage", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        let editItem = NSMenuItem(); editItem.title = "编辑"; menu.addItem(editItem)
        let edit = NSMenu(title: "编辑"); editItem.submenu = edit
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); viewItem.title = "显示"; menu.addItem(viewItem)
        let view = NSMenu(title: "显示"); viewItem.submenu = view
        view.addItem(withTitle: "重新连接", action: #selector(reconnect), keyEquivalent: "r").target = self
        view.addItem(withTitle: "在浏览器中打开", action: #selector(openBrowser), keyEquivalent: "").target = self
        let windowItem = NSMenuItem(); windowItem.title = "窗口"; menu.addItem(windowItem)
        let windows = NSMenu(title: "窗口"); windowItem.submenu = windows; NSApp.windowsMenu = windows
        windows.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windows.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Agent iMessage"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 620, height: 480)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        window.contentView = NSHostingView(rootView: GatewayRootView(store: gatewayStore))
        window.center()
        window.setFrameAutosaveName("AgentGatewayMainWindow")
        if let screen = window.screen ?? NSScreen.main {
            var frame = window.frame
            frame.size.width = min(frame.width, screen.visibleFrame.width)
            frame.size.height = min(frame.height, screen.visibleFrame.height)
            frame.origin.x = max(screen.visibleFrame.minX, min(frame.origin.x, screen.visibleFrame.maxX - frame.width))
            frame.origin.y = max(screen.visibleFrame.minY, min(frame.origin.y, screen.visibleFrame.maxY - frame.height))
            window.setFrame(frame, display: false)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        setupStatusItem()
        smokeRecord("launched")
        startService()
        if smokeEnabled && CommandLine.arguments.contains("--smoke-quit-start") {
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    var smokeEnabled: Bool { Bundle.main.bundleIdentifier?.hasSuffix(".standalone-test") == true }
    var smokeEvents: [[String: Any]] = []
    var smokeScheduled = false
    func smokeRecord(_ event: String) {
        guard smokeEnabled, let path = ProcessInfo.processInfo.environment["AGENT_GATEWAY_SMOKE_REPORT"] else { return }
        smokeEvents.append(["event": event, "pid": ProcessInfo.processInfo.processIdentifier,
                            "target": target, "owned": ownsService, "visible": window.isVisible,
                            "accessory": NSApp.activationPolicy() == .accessory,
                            "menu": statusItem.menu?.items.map { $0.title } ?? []])
        if let data = try? JSONSerialization.data(withJSONObject: smokeEvents) {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
    }
    func smokeReady() {
        guard smokeEnabled && !smokeScheduled else { return }
        smokeScheduled = true
        smokeRecord("ready")
        if CommandLine.arguments.contains("--smoke-close") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.window.performClose(nil)
                self.smokeRecord("closed")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.showWindow() // same target/action as the menu bar entry
                    self.smokeRecord("reopened")
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func startService() {
        guard !starting && !closing else { return }
        let job: [String: Any]
        do { job = try serviceJob() }
        catch { showError("无法读取配置或准备本机服务。\(error.localizedDescription)"); return }
        starting = true
        setStatus("正在连接本机服务…", symbol: "bubble.left.and.bubble.right")
        window.subtitle = "正在连接本机服务…"
        let endpoint = url.appendingPathComponent("api/state")
        serviceQueue.async {
            do {
                let owned = try self.service.connect(job: job) {
                    let ready = DispatchSemaphore(value: 0)
                    var found = false
                    var request = URLRequest(url: endpoint)
                    request.timeoutInterval = 1
                    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
                        if (response as? HTTPURLResponse)?.statusCode == 200, let data = data,
                           let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                            found = state["routes"] is [Any] && state["config"] is [String: Any]
                        }
                        ready.signal()
                    }
                    task.resume()
                    ready.wait()
                    return found
                }
                RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
                    self.starting = false
                    self.ownsService = owned
                    if self.closing { self.finishTermination(); return }
                    self.pollGeneration += 1
                    self.poll(60, generation: self.pollGeneration)
                }
            } catch {
                RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
                    self.starting = false
                    if self.closing { self.finishTermination(); return }
                    self.showError(error.localizedDescription)
                }
            }
        }
    }
    @objc func reconnect() { startService() }
    @objc func openBrowser() { NSWorkspace.shared.open(url) }
    func poll(_ remaining: Int, generation: Int) {
        guard !closing && generation == pollGeneration else { return }
        var request = URLRequest(url: url.appendingPathComponent("api/state"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                guard !self.closing && generation == self.pollGeneration else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.window.subtitle = ""
                    self.gatewayStore.start(url: self.url)
                    self.refreshStatus()
                    self.smokeReady()
                } else if remaining > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.poll(remaining - 1, generation: generation) }
                } else { self.showError("无法连接本机服务。修复配置后可点击重新连接。") }
            }
        }.resume()
    }
    func showError(_ message: String) {
        setStatus("连接失败 · 可重新连接", symbol: "exclamationmark.bubble")
        window.subtitle = "连接失败 · 可重试"
        guard window.isVisible else { return }
        let alert = NSAlert()
        alert.messageText = "暂时无法连接 Agent Gateway"
        alert.informativeText = message
        alert.addButton(withTitle: "重新连接")
        alert.addButton(withTitle: "稍后")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { self.reconnect() }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        showWindow()
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !closing else { return .terminateLater }
        closing = true
        pollGeneration += 1
        setStatus("正在退出…", symbol: "bubble.left.and.bubble.right")
        if !starting { finishTermination() }
        return .terminateLater
    }
    func finishTermination() {
        smokeRecord("quitting")
        serviceQueue.async {
            let stopped = self.service.stop()
            RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) {
                if stopped {
                    self.smokeRecord("stopped")
                    self.statusTimer?.invalidate()
                    Task { @MainActor in self.gatewayStore.stop() }
                    NSApp.reply(toApplicationShouldTerminate: true)
                } else {
                    self.closing = false
                    NSApp.reply(toApplicationShouldTerminate: false)
                    self.showWindow()
                    self.showError("本机服务尚未停止，应用仍在运行。请重试退出；服务归属记录已保留。")
                }
            }
        }
    }

    @MainActor @objc func showSettings() {
        if settingsWindow == nil {
            let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 380), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            panel.title = "设置"
            panel.isReleasedWhenClosed = false
            panel.contentView = NSHostingView(rootView: NativeSettingsView(store: gatewayStore))
            panel.center()
            settingsWindow = panel
        }
        NSApp.setActivationPolicy(.regular)
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

}

@main
struct DesktopApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}

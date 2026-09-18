import Cocoa
import WebKit

// Local desktop wrapper. launchd supervises the service only while this app is open.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var ownsService = false
    var closing = false
    var target: String { "gui/\(getuid())/\(serviceTarget)" }
    var starting = false
    var pollGeneration = 0
    var serviceTarget: String { Bundle.main.object(forInfoDictionaryKey: "GatewayServiceLabel") as? String ?? "app.agent-imessage.gateway" }
    var url: URL { URL(string: Bundle.main.object(forInfoDictionaryKey: "GatewayURL") as? String ?? "http://127.0.0.1:8787/")! }

    @discardableResult func launchctl(_ args: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus }
        catch { return -1 }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set the running Dock icon explicitly; Launch Services can retain the
        // generic icon when a local app bundle is updated in place.
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
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
        window.minSize = NSSize(width: 620, height: 480)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        web = WKWebView()
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
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
        web.loadHTMLString("<meta charset='utf-8'><p style='font:20px system-ui;padding:40px'>正在启动 Agent iMessage…</p>", baseURL: nil)
        startService()
        // Exercise the normal window-close lifecycle in a local smoke test.
        if CommandLine.arguments.contains("--smoke-close") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { self.window.performClose(nil) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 9) {
                precondition(!self.window.isVisible && self.launchctl(["print", self.target]) == 0)
                _ = self.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
                precondition(self.window.isVisible)
                print("PASS: close preserves service; reopen restores window")
                NSApp.terminate(nil)
            }
        }
    }

    func startService() {
        guard !starting && !closing else { return }
        starting = true
        window.subtitle = "正在连接本机服务…"
        DispatchQueue.global(qos: .userInitiated).async {
            let alreadyRunning = self.launchctl(["print", self.target]) == 0
            let plist = Bundle.main.resourceURL!.appendingPathComponent("gateway.plist").path
            let started = !alreadyRunning && self.launchctl(["bootstrap", "gui/\(getuid())", plist]) == 0
            DispatchQueue.main.async {
                self.starting = false
                if self.closing {
                    DispatchQueue.global().async {
                        if started { self.launchctl(["bootout", self.target]) }
                        DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
                    }
                    return
                }
                guard alreadyRunning || started else { self.showError("无法启动服务。请检查 Node、项目目录和配置。可在“显示”菜单重新连接。"); return }
                self.ownsService = self.ownsService || started
                self.pollGeneration += 1
                self.poll(60, generation: self.pollGeneration)
            }
        }
    }
    @objc func reconnect() { startService() }
    @objc func openBrowser() { NSWorkspace.shared.open(url) }
    func poll(_ remaining: Int, generation: Int) {
        guard !closing && generation == pollGeneration else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                guard !self.closing && generation == self.pollGeneration else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.window.subtitle = self.ownsService ? "本机服务 · 退出应用时停止" : "已连接后台服务 · 退出应用后继续运行"
                    self.web.load(URLRequest(url: self.url))
                } else if remaining > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.poll(remaining - 1, generation: generation) }
                } else { self.showError("无法连接本机服务。修复配置后可点击重新连接。") }
            }
        }.resume()
    }
    func showError(_ message: String) {
        window.subtitle = "连接失败 · 可重试"
        let alert = NSAlert()
        alert.messageText = "暂时无法连接 Agent Gateway"
        alert.informativeText = message
        alert.addButton(withTitle: "重新连接")
        alert.addButton(withTitle: "稍后")
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { self.reconnect() }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { window.subtitle = "页面加载失败 · 点击重新连接" }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !closing {
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
            sender.activate(ignoringOtherApps: true)
        }
        return true
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        closing = true
        if starting { return .terminateLater }
        guard ownsService else { return .terminateNow }
        ownsService = false
        DispatchQueue.global().async {
            self.launchctl(["bootout", self.target])
            // bootout may return before launchd finishes removing the job.
            for _ in 0..<100 {
                if self.launchctl(["print", self.target]) != 0 { break }
                Thread.sleep(forTimeInterval: 0.2)
            }
            RunLoop.main.perform(inModes: [.default, .modalPanel, .eventTracking]) { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let destination = action.request.url else { decisionHandler(.cancel); return }
        if destination.scheme == "about" || (destination.scheme == url.scheme && destination.host == url.host && destination.port == url.port) {
            decisionHandler(.allow)
        } else {
            if ["https", "http"].contains(destination.scheme ?? "") { NSWorkspace.shared.open(destination) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let destination = action.request.url, ["https", "http"].contains(destination.scheme ?? "") { NSWorkspace.shared.open(destination) }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { result in completionHandler(result == .alertFirstButtonReturn) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

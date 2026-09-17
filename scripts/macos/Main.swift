import Cocoa
import WebKit

// Local desktop wrapper. launchd supervises the service only while this app is open.
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var ownsService = false
    var closing = false
    let target = "gui/\(getuid())/app.agent-imessage.gateway"
    let url = URL(string: "http://127.0.0.1:8787/")!

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
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Agent iMessage"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 600)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = .windowBackgroundColor
        web = WKWebView()
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<meta charset='utf-8'><p style='font:20px system-ui;padding:40px'>正在启动 Agent iMessage…</p>", baseURL: nil)
        guard launchctl(["print", target]) != 0 else {
            showError("后台服务已由其他方式启动。请先停止后台服务，再打开应用，以确保关闭应用时能停止服务。")
            return
        }
        let plist = Bundle.main.resourceURL!.appendingPathComponent("gateway.plist").path
        guard launchctl(["bootstrap", "gui/\(getuid())", plist]) == 0 else {
            showError("无法启动服务。请检查本地 Node、仓库目录和服务配置。")
            return
        }
        ownsService = true
        poll(60)
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

    func poll(_ remaining: Int) {
        guard !closing else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                guard !self.closing else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.web.load(URLRequest(url: self.url))
                } else if remaining > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.poll(remaining - 1) }
                } else {
                    self.showError("服务未能启动。日志：~/.config/agent-imessage/logs/gateway.log")
                }
            }
        }.resume()
    }

    func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Agent iMessage 启动失败"
        alert.informativeText = message
        alert.runModal()
        NSApp.terminate(nil)
    }

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
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

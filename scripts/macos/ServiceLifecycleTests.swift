import Foundation

@main
struct ServiceLifecycleTests {
    static func main() throws {
        let fm = FileManager.default
        let directory = fm.temporaryDirectory.appendingPathComponent("gateway-ownership-" + UUID().uuidString)
        let label = "app.agent-imessage.lifecycle-test." + UUID().uuidString
        let controller = GatewayService(label: label, directory: directory)
        var cleanup = Set<String>()
        defer {
            if let data = try? Data(contentsOf: controller.receipt), let record = try? JSONDecoder().decode(GatewayService.Record.self, from: data) {
                cleanup.insert(record.label)
            }
            for name in cleanup { _ = GatewayService.command(["bootout", "gui/\(getuid())/\(name)"]) }
            try? fm.removeItem(at: directory)
        }
        // sleep ignores trailing args, providing an inert long-lived job with
        // the same four-argument shape as Gateway; no real messages or config.
        let job: [String: Any] = ["Label": label, "ProgramArguments": ["/bin/sh", "-c", "exec /bin/sleep 120", directory.appendingPathComponent("config.json").path], "RunAtLoad": true]
        func check(_ condition: Bool, _ message: String) throws {
            guard condition else { throw NSError(domain: "LifecycleTest", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
            print("PASS: " + message)
        }
        try check(try controller.connect(job: job, endpointRunning: { false }), "fresh job is owned")
        let first = controller.owned!
        cleanup.insert(first.label)
        let resumed = GatewayService(label: label, directory: directory)
        try check(try resumed.connect(job: job, endpointRunning: { true }), "new app instance adopts orphan without restarting it")
        try check(resumed.owned?.token == first.token, "adoption preserves launch identity")
        let otherConfig = GatewayService(label: label, directory: directory)
        var differentJob = job
        differentJob["ProgramArguments"] = ["/bin/sh", "-c", "exec /bin/sleep 120", directory.appendingPathComponent("other.json").path]
        try check(try !otherConfig.connect(job: differentJob, endpointRunning: { true }), "different configuration cannot claim orphan")
        try check(otherConfig.stop() && GatewayService.command(["print", "gui/\(getuid())/\(first.label)"]).0 == 0, "different configuration leaves orphan intact")
        try check(resumed.stop(), "adopted job stops on normal Quit")
        try check(GatewayService.command(["print", "gui/\(getuid())/\(first.label)"]).0 != 0, "owned launchd job removed")
        try check(!fm.fileExists(atPath: controller.receipt.path), "receipt removed only after successful stop")

        try check(try controller.connect(job: job, endpointRunning: { false }), "next launch creates fresh identity")
        let replaced = controller.owned!
        cleanup.insert(replaced.label)
        _ = GatewayService.command(["bootout", "gui/\(getuid())/\(replaced.label)"])
        var foreign = job
        foreign["Label"] = replaced.label
        // Same label and even same plist path, but NOT the launch identity.
        try PropertyListSerialization.data(fromPropertyList: foreign, format: .xml, options: 0).write(to: URL(fileURLWithPath: replaced.plist))
        try check(GatewayService.command(["bootstrap", "gui/\(getuid())", replaced.plist]).0 == 0, "foreign replacement started")
        try check(controller.stop(), "Quit relinquishes replaced job")
        try check(GatewayService.command(["print", "gui/\(getuid())/\(replaced.label)"]).0 == 0, "foreign replacement survives Quit")
        let rejected = GatewayService(label: label, directory: directory)
        try check(try !rejected.connect(job: job, endpointRunning: { true }), "stale receipt does not adopt foreign server")
        try check(rejected.stop(), "external connection quits harmlessly")
        _ = GatewayService.command(["bootout", "gui/\(getuid())/\(replaced.label)"])

        let external = directory.appendingPathComponent("manual.plist")
        try PropertyListSerialization.data(fromPropertyList: job, format: .xml, options: 0).write(to: external)
        try check(GatewayService.command(["bootstrap", "gui/\(getuid())", external.path]).0 == 0, "manual base-label service started")
        cleanup.insert(label)
        try check(try !rejected.connect(job: job, endpointRunning: { false }), "manual launchd service stays external")
        try check(rejected.stop(), "external Quit succeeds without stopping service")
        try check(GatewayService.command(["print", "gui/\(getuid())/\(label)"]).0 == 0, "manual service survives Quit")
        _ = GatewayService.command(["bootout", "gui/\(getuid())/\(label)"])
        try check(try !rejected.connect(job: job, endpointRunning: { true }), "directly started endpoint stays external")
        try check(rejected.owned == nil, "port availability never establishes ownership")
    }
}

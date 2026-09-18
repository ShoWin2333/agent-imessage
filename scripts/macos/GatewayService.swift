import Foundation

/// Owns only launchd jobs carrying a persisted, per-launch identity. All methods
/// run on the serial service queue, never on AppKit's main thread.
final class GatewayService {
    struct Record: Codable {
        let label: String
        let token: String
        let config: String
        let plist: String
    }
    let baseLabel: String
    let directory: URL
    let receipt: URL
    private(set) var owned: Record?
    var target: String { "gui/\(getuid())/\(owned?.label ?? baseLabel)" }

    init(label: String, directory: URL) {
        baseLabel = label
        self.directory = directory.standardizedFileURL.resolvingSymlinksInPath()
        receipt = self.directory.appendingPathComponent("\(label).owner.json")
    }

    static func command(_ arguments: [String]) -> (Int32, String) {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (process.terminationStatus, String(decoding: data, as: UTF8.self))
        } catch { return (-1, "") }
    }

    private func target(_ record: Record) -> String { "gui/\(getuid())/\(record.label)" }
    private func load() -> Record? {
        guard let data = try? Data(contentsOf: receipt), let record = try? JSONDecoder().decode(Record.self, from: data),
              record.label.hasPrefix(baseLabel + ".owned."), UUID(uuidString: record.token) != nil,
              record.plist == directory.appendingPathComponent(record.label + ".plist").path else { return nil }
        return record
    }
    private func matches(_ record: Record) -> Bool {
        let (status, output) = Self.command(["print", target(record)])
        let lines = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let loadedPath = lines.first(where: { $0.hasPrefix("path = ") }).map { String($0.dropFirst(7)) }
        let expectedPath = URL(fileURLWithPath: record.plist).standardizedFileURL.resolvingSymlinksInPath().path
        let actualPath = loadedPath.map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path }
        return status == 0 && actualPath == expectedPath &&
            lines.contains("AGENT_GATEWAY_OWNER => \(record.token)")
    }

    /// The receipt is written BEFORE bootstrap. A crash at any later point can
    /// be recovered without inferring ownership from a PID, port or bundle path.
    func connect(job: [String: Any], endpointRunning: () -> Bool) throws -> Bool {
        owned = nil
        guard let args = job["ProgramArguments"] as? [String], args.count >= 4 else {
            throw failure("服务启动参数不完整。")
        }
        let config = URL(fileURLWithPath: args[3]).standardizedFileURL.resolvingSymlinksInPath().path
        if let previous = load(), previous.config == config, matches(previous) {
            owned = previous
            return true
        }
        // Legacy/manual jobs and servers started outside launchd remain external.
        if Self.command(["print", "gui/\(getuid())/\(baseLabel)"]).0 == 0 || endpointRunning() { return false }
        if let previous = load(), Self.command(["print", target(previous)]).0 == 0 {
            throw failure("发现其他配置或归属不明的服务，已保留它。请先检查后台服务。")
        }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let token = UUID().uuidString
        let label = baseLabel + ".owned." + token
        let record = Record(label: label, token: token, config: config, plist: directory.appendingPathComponent(label + ".plist").path)
        var managed = job
        managed["Label"] = label
        var environment = managed["EnvironmentVariables"] as? [String: String] ?? [:]
        environment["AGENT_GATEWAY_OWNER"] = token
        managed["EnvironmentVariables"] = environment
        let data = try PropertyListSerialization.data(fromPropertyList: managed, format: .xml, options: 0)
        try data.write(to: URL(fileURLWithPath: record.plist), options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.plist)
        try JSONEncoder().encode(record).write(to: receipt, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: receipt.path)
        guard Self.command(["bootstrap", "gui/\(getuid())", record.plist]).0 == 0, matches(record) else {
            // Retain the receipt on uncertainty: it is needed to recover a job
            // that bootstrap may have loaded even if verification failed.
            throw failure("无法启动本机服务，请检查配置和应用完整性。")
        }
        owned = record
        return true
    }

    /// Revalidate immediately before bootout; an external replacement is never
    /// stopped merely because this process once owned the same launchd label.
    func stop() -> Bool {
        guard let record = owned else { return true }
        guard matches(record) else { owned = nil; return true }
        let result = Self.command(["bootout", target(record)]).0
        for _ in 0..<50 {
            if Self.command(["print", target(record)]).0 != 0 {
                if load()?.token == record.token { try? FileManager.default.removeItem(at: receipt) }
                try? FileManager.default.removeItem(atPath: record.plist)
                owned = nil
                return true
            }
            if result != 0 { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false // Keep receipt and ownership so Quit can be retried.
    }

    private func failure(_ text: String) -> NSError {
        NSError(domain: "GatewayService", code: 1, userInfo: [NSLocalizedDescriptionKey: text])
    }
}

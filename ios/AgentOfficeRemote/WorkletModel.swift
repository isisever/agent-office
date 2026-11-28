import BareKit
import Foundation
import Network
import os

// MARK: - Keychain

/// Minimal generic-password keychain wrapper for the key seed and the paired desktop record.
enum Keychain {
  private static let service = "com.savasisisever.agentoffice.remote"

  static func get(_ key: String) -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func set(_ value: String, for key: String) {
    remove(key)
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: key, kSecValueData as String: Data(value.utf8),
                            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    SecItemAdd(q as CFDictionary, nil)
  }

  static func remove(_ key: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    SecItemDelete(q as CFDictionary)
  }
}

// MARK: - Domain types (what the desktop sends: ctl-view, ctl-event, ctl-hq-status, ctl-reports, sess-items)

struct PairedDesktop: Equatable {
  var pub: String
  var secret: String
  var name: String
  var dict: [String: String] { ["pub": pub, "secret": secret, "name": name] }
  init?(_ d: [String: Any]) {
    guard let pub = d["pub"] as? String, let secret = d["secret"] as? String else { return nil }
    self.pub = pub; self.secret = secret; self.name = d["name"] as? String ?? "Agent Office"
  }
}

struct Project: Identifiable, Equatable {
  let id: String
  var name: String
  var engine: String
  var status: String          // working | idle | approval
  var working: Int
  var sessions: Int
  var attention: String?      // permission | done
  var tool: String?
}

struct HQItem: Identifiable, Equatable {
  let id: String              // the item key
  var kind: String            // user | assistant | error | command | tool | toolDone | note
  var at: Int
  var text: String
  var toolId: String?
}

enum OutStatus { case sending, queued, delivered, rejected }

struct OutMessage: Identifiable, Equatable {
  let id: String
  var text: String
  var at: Date
  var status: OutStatus
  var reason: String?
}

struct Report: Identifiable, Equatable {
  let id: String
  var at: Int
  var project: String
  var title: String
  var summary: String
  var date: Date { Date(timeIntervalSince1970: at > 100_000_000_000 ? Double(at) / 1000 : Double(at)) }
}

// MARK: - Model

/// Owns the Bare worklet (the P2P link stack) and its IPC: newline-delimited JSON both ways, and turns the
/// desktop's controller messages into observable state for the UI.
@MainActor
final class WorkletModel: ObservableObject {
  @Published private(set) var state = "starting"
  @Published private(set) var paired: PairedDesktop?
  @Published private(set) var pairError: String?
  @Published private(set) var projects: [Project] = []
  @Published private(set) var hasView = false
  @Published private(set) var hqStatus: String?
  @Published private(set) var delivered = 0
  @Published private(set) var hqItems: [HQItem] = []
  @Published private(set) var toolResults: [String: Bool] = [:]   // tool id -> failed
  @Published private(set) var outbox: [OutMessage] = []
  @Published private(set) var sessionEnded: String?
  @Published private(set) var reports: [Report] = []
  @Published private(set) var reportsLoaded = false
  @Published private(set) var networkUp = true
  @Published private(set) var lines: [String] = []
  @Published private(set) var fatalError: String?

  private let logger = Logger(subsystem: "com.savasisisever.agentoffice.remote", category: "worklet")
  private var worklet: Worklet?
  private var ipc: IPC?
  private var pending = Data()
  private var sessionId = ""
  private var keepTask: Task<Void, Never>?
  private var reportsStamp = 0
  private let monitor = NWPathMonitor()

  var isOnline: Bool { state == "online" }
  var hasPairing: Bool { paired != nil }

  // MARK: lifecycle

  func start() {
    guard worklet == nil else { return }
    monitor.pathUpdateHandler = { [weak self] path in
      let up = path.status == .satisfied
      Task { @MainActor in self?.networkUp = up }
    }
    monitor.start(queue: DispatchQueue(label: "net-monitor"))
    if let demo = UserDefaults.standard.string(forKey: "uiDemo") { loadDemo(demo); return }
    migrateLegacyStorage()
    if let json = Keychain.get("paired"), let data = json.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { paired = PairedDesktop(obj) }
    do {
      let worklet = try Worklet()
      let ipc = try IPC(worklet: worklet)
      try worklet.start("app.bundle")
      self.worklet = worklet
      self.ipc = ipc
      append("worklet started")
      var initMsg: [String: Any] = ["t": "init", "name": UIDeviceName.value]
      if let seed = Keychain.get("seed") { initMsg["seed"] = seed }
      if let paired { initMsg["paired"] = paired.dict }
      send(initMsg)
      Task { [weak self] in
        for await chunk in ipc { self?.receive(chunk) }
        self?.append("IPC closed")
      }
      // launch argument for simulator and UI tests: -pairCode <agentoffice://pair?... URL>
      if paired == nil, let url = UserDefaults.standard.string(forKey: "pairCode"), url.hasPrefix("agentoffice://") {
        Task { [weak self] in try? await Task.sleep(nanoseconds: 800_000_000); self?.connect(url) }
      }
    } catch {
      state = "failed"
      fatalError = "worklet failed to start: \(error)"
      append("worklet failed: \(error)")
    }
  }

  private func migrateLegacyStorage() {
    let d = UserDefaults.standard
    if Keychain.get("seed") == nil, let s = d.string(forKey: "ctlSeed") { Keychain.set(s, for: "seed") }
    if Keychain.get("paired") == nil, let p = d.dictionary(forKey: "ctlPaired"),
       let data = try? JSONSerialization.data(withJSONObject: p), let s = String(data: data, encoding: .utf8) { Keychain.set(s, for: "paired") }
    d.removeObject(forKey: "ctlSeed"); d.removeObject(forKey: "ctlPaired")
  }

  // MARK: commands

  /// Pairs from a scanned `agentoffice://pair?...` link.
  func connect(_ input: String) {
    let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    pairError = nil
    guard text.hasPrefix("agentoffice://") else { pairError = "bad-url"; return }
    send(["t": "pair", "url": text])
  }

  func cancelPairing() { pairError = nil; send(["t": "forget"]) }

  func unpair() {
    Keychain.remove("paired")
    paired = nil
    resetData()
    send(["t": "forget"])
  }

  func suspend() {
    guard worklet != nil else { return }
    send(["t": "suspend"])
    worklet?.suspend(linger: 5000)
    append("suspend (linger 5 s)")
  }

  func resume() {
    guard worklet != nil else { return }
    worklet?.resume()
    send(["t": "resume"])
    append("resume")
  }

  func terminate() {
    keepTask?.cancel()
    ipc?.close()
    worklet?.terminate()
    worklet = nil
    ipc = nil
  }

  /// Types one HQ turn on the paired desktop; its ctl-hq-status answer updates the message.
  func sendHq(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return }
    let id = "i" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<36 * 36), radix: 36)
    let live = isOnline
    outbox.append(OutMessage(id: id, text: t, at: Date(), status: live ? .sending : .rejected, reason: live ? nil : "offline"))
    if live { send(["t": "send", "msg": ["t": "ctl-hq", "id": id, "text": t]]) }
  }

  func retry(_ id: String) {
    guard let i = outbox.firstIndex(where: { $0.id == id }) else { return }
    let text = outbox[i].text
    outbox.remove(at: i)
    sendHq(text)
  }

  func discard(_ id: String) { outbox.removeAll { $0.id == id } }

  func requestReports() {
    let id = "r" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
    send(["t": "send", "msg": ["t": "ctl-reports", "id": id, "limit": 20]])
  }

  /// Pull-to-refresh for the reports: asks again and waits (up to 4 s) for the answer.
  func refreshReports() async {
    guard isOnline else { return }
    let before = reportsStamp
    requestReports()
    for _ in 0..<40 { if reportsStamp != before { break }; try? await Task.sleep(nanoseconds: 100_000_000) }
  }

  private func openSession() {
    sessionId = "hq" + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
    sessionEnded = nil
    send(["t": "send", "msg": ["t": "sess-open", "id": sessionId, "project": "hq"]])
    keepTask?.cancel()
    keepTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        guard let self, !Task.isCancelled, self.isOnline else { continue }
        self.send(["t": "send", "msg": ["t": "sess-keep", "id": self.sessionId]])
      }
    }
  }

  // MARK: IPC

  private func send(_ message: [String: Any]) {
    guard let ipc, var data = try? JSONSerialization.data(withJSONObject: message) else { return }
    data.append(0x0A)
    Task { try? await ipc.write(data) }
  }

  private func receive(_ chunk: Data) {
    pending.append(chunk)
    while let nl = pending.firstIndex(of: 0x0A) {
      let line = pending[pending.startIndex..<nl]
      pending.removeSubrange(pending.startIndex...nl)
      guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let t = obj["t"] as? String else { continue }
      handle(t, obj)
    }
  }

  private func handle(_ t: String, _ obj: [String: Any]) {
    switch t {
    case "log":
      let line = obj["line"] as? String ?? ""
      if line.hasPrefix("pair failed: ") {
        let code = String(line.dropFirst("pair failed: ".count))
        if code != "cancelled" && code != "destroyed" { pairError = code }
      }
      append(line)
    case "status": setState(obj["state"] as? String ?? state)
    case "fatal":
      let text = obj["error"] as? String ?? "unknown error"
      state = "failed"; fatalError = text; append("FATAL \(text)")
    case "ready": if let seed = obj["seed"] as? String { Keychain.set(seed, for: "seed") }
    case "paired":
      if let p = obj["paired"] as? [String: Any], let desk = PairedDesktop(p),
         let data = try? JSONSerialization.data(withJSONObject: desk.dict), let json = String(data: data, encoding: .utf8) {
        Keychain.set(json, for: "paired")
        paired = desk
        pairError = nil
        append("paired with \(desk.name)")
      }
    case "recv": if let msg = obj["msg"] as? [String: Any] { handleRecv(msg) }
    default: break
    }
  }

  private func setState(_ s: String) {
    let was = state
    state = s
    if s == "pairing" { pairError = nil }
    if s == "online" && was != "online" { openSession(); requestReports() }
    if s == "unpaired" && paired != nil && was != "pairing" { /* the worklet restarted without a pairing: keep the stored one */ }
  }

  private func handleRecv(_ msg: [String: Any]) {
    guard let t = msg["t"] as? String else { return }
    switch t {
    case "ctl-view":
      guard let view = msg["view"] as? [String: Any] else { return }
      projects = (view["projects"] as? [[String: Any]] ?? []).compactMap(Self.project)
      hqStatus = (view["hq"] as? [String: Any])?["status"] as? String
      delivered = view["delivered"] as? Int ?? 0
      if let n = view["name"] as? String, var p = paired, p.name != n { p.name = n; paired = p }
      hasView = true
    case "ctl-event":
      guard let e = msg["event"] as? [String: Any], let pid = e["project"] as? String, let status = e["status"] as? String else { return }
      if pid == "hq" { hqStatus = status; return }
      if let i = projects.firstIndex(where: { $0.id == pid }) {
        projects[i].status = status
        projects[i].attention = e["attention"] as? String
      }
    case "ctl-hq-status":
      guard let id = msg["id"] as? String, let i = outbox.firstIndex(where: { $0.id == id }) else { return }
      switch msg["status"] as? String {
      case "queued": outbox[i].status = .queued
      case "delivered":
        outbox[i].status = .delivered
        Task { [weak self] in try? await Task.sleep(nanoseconds: 3_000_000_000); self?.discard(id) }
      default: outbox[i].status = .rejected; outbox[i].reason = msg["reason"] as? String ?? "failed"
      }
    case "ctl-reports":
      guard let list = msg["reports"] as? [[String: Any]] else { return }
      reports = list.compactMap { r in
        guard let id = r["id"] as? String else { return nil }
        return Report(id: id, at: r["at"] as? Int ?? 0, project: r["project"] as? String ?? "", title: r["title"] as? String ?? "", summary: r["summary"] as? String ?? "")
      }.sorted { $0.at > $1.at }
      reportsLoaded = true
      reportsStamp += 1
    case "sess-items":
      guard msg["id"] as? String == sessionId, let items = msg["items"] as? [[String: Any]] else { return }
      if msg["reset"] as? Bool == true { hqItems = []; toolResults = [:] }
      for it in items { applySessItem(it) }
      if hqItems.count > 400 { hqItems.removeFirst(hqItems.count - 400) }
    case "sess-end":
      guard msg["id"] as? String == sessionId else { return }
      sessionEnded = msg["reason"] as? String ?? "ended"
    default: break
    }
  }

  private func applySessItem(_ it: [String: Any]) {
    guard let kind = it["kind"] as? String, let key = it["key"] as? String else { return }
    if kind == "toolDone" { if let id = it["id"] as? String { toolResults[id] = it["error"] as? Bool ?? false }; return }
    var text = it["text"] as? String ?? ""
    if kind == "tool" { text = (it["name"] as? String ?? "tool") + ((it["detail"] as? String).map { " \($0)" } ?? "") }
    if kind == "note" { text = it["note"] as? String ?? "" }
    let item = HQItem(id: key, kind: kind, at: it["at"] as? Int ?? 0, text: text, toolId: it["id"] as? String)
    if let i = hqItems.firstIndex(where: { $0.id == key }) { hqItems[i] = item } else { hqItems.append(item) }
  }

  private static func project(_ p: [String: Any]) -> Project? {
    guard let id = p["id"] as? String, let status = p["status"] as? String else { return nil }
    return Project(id: id, name: p["name"] as? String ?? "?", engine: p["engine"] as? String ?? "claude", status: status,
                   working: p["working"] as? Int ?? 0, sessions: p["sessions"] as? Int ?? 0,
                   attention: p["attention"] as? String, tool: p["tool"] as? String)
  }

  private func resetData() {
    projects = []; hasView = false; hqStatus = nil; delivered = 0; hqItems = []; toolResults = [:]
    outbox = []; reports = []; reportsLoaded = false; sessionEnded = nil
    keepTask?.cancel()
  }

  private func append(_ line: String) {
    logger.notice("\(line, privacy: .public)")
    lines.append(line)
    if lines.count > 500 { lines.removeFirst(lines.count - 500) }
  }

  // MARK: demo data (launch with `-uiDemo office|hq|reports|settings|onboarding|pairing|error`; no network, for screenshots)

  private func loadDemo(_ scene: String) {
    let now = Int(Date().timeIntervalSince1970 * 1000)
    if scene == "onboarding" || scene == "pairing" || scene == "error" {
      state = scene == "pairing" ? "pairing" : "unpaired"
      if scene == "error" { pairError = "expired" }
      return
    }
    paired = PairedDesktop(["pub": String(repeating: "a", count: 64), "secret": String(repeating: "b", count: 64), "name": "Studio MacBook Pro"])
    state = "online"
    projects = [
      Project(id: "p1", name: "agent-office", engine: "claude", status: "approval", working: 0, sessions: 2, attention: "permission", tool: "Bash npm test"),
      Project(id: "p2", name: "clawd-office", engine: "claude", status: "working", working: 2, sessions: 3, attention: nil, tool: "Edit link.js"),
      Project(id: "p3", name: "nodesyai-connect", engine: "agy", status: "idle", working: 0, sessions: 1, attention: "done", tool: nil),
      Project(id: "p4", name: "docs-site", engine: "opencode", status: "idle", working: 0, sessions: 0, attention: nil, tool: nil),
    ]
    hasView = true; hqStatus = "working"; delivered = 12
    hqItems = [
      HQItem(id: "1", kind: "user", at: now - 600_000, text: "What is blocking the release?", toolId: nil),
      HQItem(id: "2", kind: "tool", at: now - 590_000, text: "Read ios/README.md", toolId: "t1"),
      HQItem(id: "3", kind: "assistant", at: now - 580_000, text: "The only open item is the iOS build 4 upload. The archive is ready and agent-office has one pending approval for `npm test`.", toolId: nil),
      HQItem(id: "4", kind: "user", at: now - 120_000, text: "Ask agent-office to run the tests and report back", toolId: nil),
      HQItem(id: "5", kind: "assistant", at: now - 100_000, text: "Dispatched. I will post a report when the run finishes.", toolId: nil),
    ]
    toolResults = ["t1": false]
    outbox = [OutMessage(id: "o1", text: "Pause nodesyai-connect for now", at: Date(), status: .queued, reason: nil)]
    reports = [
      Report(id: "r1", at: now - 3_600_000, project: "agent-office", title: "Link tests green", summary: "All 214 link tests pass on the testnet.\n\nThe controller protocol (ctl-view, ctl-hq, ctl-reports) was exercised end to end. No regressions in pairing."),
      Report(id: "r2", at: now - 86_400_000, project: "clawd-office", title: "Viewer smoke test", summary: "The viewer renders 4 projects and the approval badge."),
      Report(id: "r3", at: now - 172_800_000, project: "nodesyai-connect", title: "Deploy finished", summary: "Version 3.121 deployed. Health checks passed."),
    ]
    reportsLoaded = true
    lines = ["demo mode: no worklet is running"]
  }
}

enum UIDeviceName {
  static var value: String { "iPhone" }
}

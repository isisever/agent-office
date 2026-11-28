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

struct ProjectSession: Identifiable, Equatable {
  let id: String              // the session id (sid)
  var title: String
  var at: Int
  var running: Bool
  var main: Bool
  var date: Date { Date(timeIntervalSince1970: at > 100_000_000_000 ? Double(at) / 1000 : Double(at)) }
}

struct ProjectDetail: Equatable {
  var sessions: [ProjectSession] = []
  var loaded = false
  var failed = false
}

struct AskOption: Equatable, Hashable {
  let key: String
  let label: String
}

/// A pending approval or question on the desktop (ctl-ask).
struct Ask: Identifiable, Equatable {
  let id: String              // askId
  var project: String
  var kind: String            // permission | question | plan
  var tool: String?
  var detail: String?
  var options: [AskOption]
  var at: Int
}

/// What one open desktop session has streamed so far.
struct Stream: Equatable {
  var items: [HQItem] = []
  var toolResults: [String: Bool] = [:]   // tool id -> failed
  var ended: String?
  var lastSeq = 0
  var received = false
}

struct SendIssue: Equatable {
  var text: String
  var reason: String
}

private struct PendingAck {
  var op: String              // send | answer | stop
  var project: String
  var text: String?
  var askId: String?
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
  @Published private(set) var streams: [String: Stream] = [:]          // "hq" or "<project>/<sid>" or "<project>"
  @Published private(set) var details: [String: ProjectDetail] = [:]    // project id -> sessions (ctl-proj)
  @Published private(set) var asks: [String: [Ask]] = [:]               // project id -> pending approvals
  @Published private(set) var sendIssue: [String: SendIssue] = [:]      // project id -> the last message that was not accepted
  @Published private(set) var busy: Set<String> = []                    // "send:<project>", "answer:<askId>", "stop:<project>"
  @Published private(set) var outbox: [OutMessage] = []
  @Published private(set) var reports: [Report] = []
  @Published private(set) var reportsLoaded = false
  @Published private(set) var networkUp = true
  @Published private(set) var lines: [String] = []
  @Published private(set) var fatalError: String?

  private let logger = Logger(subsystem: "com.savasisisever.agentoffice.remote", category: "worklet")
  private var worklet: Worklet?
  private var ipc: IPC?
  private var pending = Data()
  private var openIds: [String: String] = [:]          // stream key -> the sess-open request id
  private var wanted: [String: (project: String, sid: String?)] = [:]
  private var attempts: [String: Int] = [:]
  private var pendingAcks: [String: PendingAck] = [:]
  private var watched: [String: Int] = [:]                // project id -> last ctl-proj request time (ms)
  private var isDemo = false
  private var keepTask: Task<Void, Never>?
  private var reportsStamp = 0
  private let monitor = NWPathMonitor()

  var hqItems: [HQItem] { streams["hq"]?.items ?? [] }
  var toolResults: [String: Bool] { streams["hq"]?.toolResults ?? [:] }
  var sessionEnded: String? { streams["hq"]?.ended }
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
    if let demo = UserDefaults.standard.string(forKey: "uiDemo") { isDemo = true; loadDemo(demo); return }
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

  // MARK: sessions (the HQ chat and project sessions share one mechanism)

  static func streamKey(_ project: String, _ sid: String?) -> String { sid.map { "\(project)/\($0)" } ?? project }

  private func newId(_ prefix: String) -> String {
    prefix + String(Int(Date().timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<36 * 36), radix: 36)
  }

  /// A screen needs this session live: opens it now (or when the link is back) and re-opens it if the desktop ends it.
  func watch(_ project: String, sid: String? = nil) {
    let key = Self.streamKey(project, sid)
    wanted[key] = (project, sid)
    attempts[key] = 0
    if isOnline && openIds[key] == nil { open(key) }
    startKeeping()
  }

  /// The screen is gone: closes the session on the desktop.
  func unwatch(_ project: String, sid: String? = nil) {
    let key = Self.streamKey(project, sid)
    wanted[key] = nil
    if let id = openIds.removeValue(forKey: key) { send(["t": "send", "msg": ["t": "sess-close", "id": id]]) }
    if key != "hq" && !isDemo { streams[key] = nil }
  }

  private func open(_ key: String) {
    guard !isDemo, isOnline, let w = wanted[key] else { return }
    let id = newId("s")
    openIds[key] = id
    streams[key, default: Stream()].ended = nil
    var msg: [String: Any] = ["t": "sess-open", "id": id, "project": w.project]
    if let sid = w.sid { msg["sid"] = sid }
    send(["t": "send", "msg": msg])
  }

  /// Re-opens a session the desktop ended (HQ has no transcript until its first turn), with a growing delay.
  private func scheduleReopen(_ key: String) {
    guard wanted[key] != nil else { return }
    let n = attempts[key, default: 0]
    attempts[key] = n + 1
    let delay = UInt64(min(2 << min(n, 4), 30)) * 1_000_000_000
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: delay)
      guard let self, self.wanted[key] != nil, self.openIds[key] == nil else { return }
      if self.isOnline { self.open(key) } else { self.scheduleReopen(key) }
    }
  }

  private func startKeeping() {
    guard keepTask == nil, !isDemo else { return }
    keepTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 30_000_000_000)
        guard let self, !Task.isCancelled, self.isOnline else { continue }
        for id in self.openIds.values { self.send(["t": "send", "msg": ["t": "sess-keep", "id": id]]) }
      }
    }
  }

  private func onOnline() {
    openIds = [:]
    for key in wanted.keys { attempts[key] = 0; open(key) }
    watch("hq")
    requestReports()
    for p in watched.keys { requestProject(p) }
  }

  // MARK: project screen, sending, approving, stopping

  func requestProject(_ project: String) {
    guard isOnline else { return }
    watched[project] = Int(Date().timeIntervalSince1970 * 1000)
    send(["t": "send", "msg": ["t": "ctl-proj", "id": newId("j"), "project": project]])
  }

  func refreshProject(_ project: String) async {
    guard isOnline else { return }
    requestProject(project)
    try? await Task.sleep(nanoseconds: 700_000_000)
  }

  func sendToProject(_ project: String, _ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty else { return }
    guard isOnline else { sendIssue[project] = SendIssue(text: t, reason: "offline"); return }
    sendIssue[project] = nil
    request(PendingAck(op: "send", project: project, text: t), ["t": "ctl-send", "project": project, "text": t], busyKey: "send:\(project)")
  }

  func retrySend(_ project: String) { if let i = sendIssue[project] { sendToProject(project, i.text) } }
  func dismissIssue(_ project: String) { sendIssue[project] = nil }

  func answer(_ ask: Ask, _ answer: [String: Any]) {
    guard isOnline else { return }
    request(PendingAck(op: "answer", project: ask.project, askId: ask.id), ["t": "ctl-answer", "project": ask.project, "askId": ask.id, "answer": answer], busyKey: "answer:\(ask.id)")
  }

  func stop(_ project: String) {
    guard isOnline else { return }
    request(PendingAck(op: "stop", project: project), ["t": "ctl-stop", "project": project], busyKey: "stop:\(project)")
  }

  private func request(_ ack: PendingAck, _ body: [String: Any], busyKey: String) {
    let id = newId("a")
    var msg = body
    msg["id"] = id
    pendingAcks[id] = ack
    busy.insert(busyKey)
    send(["t": "send", "msg": msg])
    Task { [weak self] in   // no ack in 8 s: the link dropped it
      try? await Task.sleep(nanoseconds: 8_000_000_000)
      self?.finish(id, status: "rejected", reason: "offline")
    }
  }

  private func finish(_ id: String, status: String, reason: String?) {
    guard let a = pendingAcks.removeValue(forKey: id) else { return }
    switch a.op {
    case "send":
      busy.remove("send:\(a.project)")
      if status == "rejected" { sendIssue[a.project] = SendIssue(text: a.text ?? "", reason: reason ?? "failed") }
    case "answer":
      if let askId = a.askId {
        busy.remove("answer:\(askId)")
        if status == "done" || reason == "stale" { removeAsk(a.project, askId) }
      }
    default: busy.remove("stop:\(a.project)")
    }
  }

  private func removeAsk(_ project: String, _ askId: String) {
    asks[project]?.removeAll { $0.id == askId }
    if asks[project]?.isEmpty == true { asks[project] = nil }
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
    if s == "online" && was != "online" { onOnline() }
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
      let now = Int(Date().timeIntervalSince1970 * 1000)
      if let last = watched[pid], now - last > 1500 { requestProject(pid) }
    case "ctl-hq-status":
      guard let id = msg["id"] as? String, let i = outbox.firstIndex(where: { $0.id == id }) else { return }
      switch msg["status"] as? String {
      case "queued":
        outbox[i].status = .queued
        if streams["hq"]?.ended != nil { attempts["hq"] = 0; if openIds["hq"] == nil { open("hq") } }   // the first turn creates HQ's transcript
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
      guard let id = msg["id"] as? String, let key = openIds.first(where: { $0.value == id })?.key,
            let items = msg["items"] as? [[String: Any]] else { return }
      var st = streams[key] ?? Stream()
      let seq = msg["seq"] as? Int ?? 0
      if msg["reset"] as? Bool == true { st.items = []; st.toolResults = [:] }
      else if seq > st.lastSeq + 1 && st.received { openIds[key] = nil; streams[key] = st; open(key); return }   // missed a batch: start over
      st.lastSeq = seq; st.received = true; st.ended = nil
      attempts[key] = 0
      for it in items { Self.apply(it, to: &st) }
      if st.items.count > 400 { st.items.removeFirst(st.items.count - 400) }
      streams[key] = st
    case "sess-end":
      guard let id = msg["id"] as? String, let key = openIds.first(where: { $0.value == id })?.key else { return }
      openIds[key] = nil
      streams[key, default: Stream()].ended = msg["reason"] as? String ?? "ended"
      streams[key]?.received = false
      scheduleReopen(key)
    case "ctl-proj":
      guard let project = msg["project"] as? String else { return }
      if msg["error"] != nil || msg["proj"] == nil {
        details[project, default: ProjectDetail()].failed = !(details[project]?.loaded ?? false)
        return
      }
      let proj = msg["proj"] as? [String: Any] ?? [:]
      let list = (proj["sessions"] as? [[String: Any]] ?? []).compactMap { d -> ProjectSession? in
        guard let sid = d["sid"] as? String else { return nil }
        return ProjectSession(id: sid, title: d["title"] as? String ?? "", at: d["at"] as? Int ?? 0, running: d["running"] as? Bool ?? false, main: d["main"] as? Bool ?? false)
      }
      details[project] = ProjectDetail(sessions: list, loaded: true, failed: false)
      let pending = (proj["pending"] as? [[String: Any]] ?? []).compactMap { Self.ask($0, project: project) }
      if pending.isEmpty { asks[project] = nil } else { asks[project] = pending }
    case "ctl-ask":
      guard let project = msg["project"] as? String, let d = msg["ask"] as? [String: Any], let a = Self.ask(d, project: project) else { return }
      var list = asks[project] ?? []
      if let i = list.firstIndex(where: { $0.id == a.id }) { list[i] = a } else { list.append(a) }
      asks[project] = list
    case "ctl-ask-clear":
      if let project = msg["project"] as? String, let askId = msg["askId"] as? String { removeAsk(project, askId) }
    case "ctl-ack":
      if let id = msg["id"] as? String { finish(id, status: msg["status"] as? String ?? "rejected", reason: msg["reason"] as? String) }
    default: break
    }
  }

  private static func apply(_ it: [String: Any], to st: inout Stream) {
    guard let kind = it["kind"] as? String, let key = it["key"] as? String else { return }
    if kind == "toolDone" { if let id = it["id"] as? String { st.toolResults[id] = it["error"] as? Bool ?? false }; return }
    var text = it["text"] as? String ?? ""
    if kind == "tool" { text = (it["name"] as? String ?? "tool") + ((it["detail"] as? String).map { " \($0)" } ?? "") }
    if kind == "note" { text = it["note"] as? String ?? "" }
    let item = HQItem(id: key, kind: kind, at: it["at"] as? Int ?? 0, text: text, toolId: it["id"] as? String)
    if let i = st.items.firstIndex(where: { $0.id == key }) { st.items[i] = item } else { st.items.append(item) }
  }

  private static func ask(_ d: [String: Any], project: String) -> Ask? {
    guard let id = d["askId"] as? String else { return nil }
    let opts = (d["options"] as? [[String: Any]] ?? []).compactMap { o -> AskOption? in
      guard let k = o["key"] as? String else { return nil }
      return AskOption(key: k, label: o["label"] as? String ?? k)
    }
    return Ask(id: id, project: project, kind: d["kind"] as? String ?? "permission", tool: d["tool"] as? String, detail: d["detail"] as? String, options: opts, at: d["at"] as? Int ?? 0)
  }

  private static func project(_ p: [String: Any]) -> Project? {
    guard let id = p["id"] as? String, let status = p["status"] as? String else { return nil }
    return Project(id: id, name: p["name"] as? String ?? "?", engine: p["engine"] as? String ?? "claude", status: status,
                   working: p["working"] as? Int ?? 0, sessions: p["sessions"] as? Int ?? 0,
                   attention: p["attention"] as? String, tool: p["tool"] as? String)
  }

  private func resetData() {
    projects = []; hasView = false; hqStatus = nil; delivered = 0; streams = [:]; details = [:]; asks = [:]; sendIssue = [:]; busy = []
    outbox = []; reports = []; reportsLoaded = false; openIds = [:]; wanted = [:]; watched = [:]; pendingAcks = [:]
    keepTask?.cancel(); keepTask = nil
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
    var hq = Stream()
    hq.items = [
      HQItem(id: "1", kind: "user", at: now - 600_000, text: "What is blocking the release?", toolId: nil),
      HQItem(id: "2", kind: "tool", at: now - 590_000, text: "Read ios/README.md", toolId: "t1"),
      HQItem(id: "3", kind: "assistant", at: now - 580_000, text: "The only open item is the iOS build 4 upload. The archive is ready and agent-office has one pending approval for `npm test`.", toolId: nil),
      HQItem(id: "4", kind: "user", at: now - 120_000, text: "Ask agent-office to run the tests and report back", toolId: nil),
      HQItem(id: "5", kind: "assistant", at: now - 100_000, text: "Dispatched. I will post a report when the run finishes.", toolId: nil),
    ]
    hq.toolResults = ["t1": false]
    streams["hq"] = hq
    var live = Stream()
    live.items = [
      HQItem(id: "a1", kind: "user", at: now - 900_000, text: "Run the link tests and fix whatever fails", toolId: nil),
      HQItem(id: "a2", kind: "assistant", at: now - 880_000, text: "I'll start with the full link suite, then look at any failures.", toolId: nil),
      HQItem(id: "a3", kind: "tool", at: now - 870_000, text: "Read app/src/link-wire.js", toolId: "u1"),
      HQItem(id: "a4", kind: "tool", at: now - 860_000, text: "Grep validateCtl", toolId: "u2"),
      HQItem(id: "a5", kind: "tool", at: now - 850_000, text: "Edit app/src/link.js", toolId: "u3"),
      HQItem(id: "a6", kind: "assistant", at: now - 800_000, text: "The ctl2 validators are in. Now I'll run the suite to confirm nothing regressed.", toolId: nil),
      HQItem(id: "a7", kind: "tool", at: now - 30_000, text: "Bash npm test", toolId: "u4"),
    ]
    live.toolResults = ["u1": false, "u2": false, "u3": false]
    streams["p1/s1"] = live
    streams["p1"] = live   // the main session opens without a sid
    details["p1"] = ProjectDetail(sessions: [
      ProjectSession(id: "s1", title: "Run the link tests and fix whatever fails", at: now - 30_000, running: true, main: true),
      ProjectSession(id: "s2", title: "Add the project screen to the iOS app", at: now - 7_200_000, running: true, main: false),
      ProjectSession(id: "s3", title: "Why does the pairing QR expire early?", at: now - 86_400_000, running: false, main: false),
      ProjectSession(id: "s4", title: "Release notes for 0.22.54", at: now - 172_800_000, running: false, main: false),
    ], loaded: true, failed: false)
    asks["p1"] = [Ask(id: "k1", project: "p1", kind: "permission", tool: "Bash", detail: "npm test -- --runInBand", options: [], at: now - 20_000)]
    details["p2"] = ProjectDetail(sessions: [ProjectSession(id: "t1", title: "Polish the viewer smoke test", at: now - 60_000, running: true, main: true)], loaded: true, failed: false)
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

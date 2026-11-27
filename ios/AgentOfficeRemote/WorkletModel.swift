import BareKit
import Foundation
import os

/// Owns the Bare worklet (the P2P link stack) and its IPC: newline-delimited JSON both ways.
@MainActor
final class WorkletModel: ObservableObject {
  @Published private(set) var state = "stopped"
  @Published private(set) var lines: [String] = []

  private let logger = Logger(subsystem: "com.thinkone.agentoffice.remote", category: "worklet")
  private var worklet: Worklet?
  private var ipc: IPC?
  private var pending = Data()

  func start() {
    guard worklet == nil else { return }
    do {
      let worklet = try Worklet()
      let ipc = try IPC(worklet: worklet)
      try worklet.start("app.bundle")
      self.worklet = worklet
      self.ipc = ipc
      state = "starting"
      append("worklet started")
      // v3.121 P1: the seed and the paired desktop live in UserDefaults for now; P3 moves them to the keychain
      var initMsg: [String: Any] = ["t": "init", "name": "iPhone"]
      if let seed = UserDefaults.standard.string(forKey: "ctlSeed") { initMsg["seed"] = seed }
      if let paired = UserDefaults.standard.dictionary(forKey: "ctlPaired") { initMsg["paired"] = paired }
      send(initMsg)
      Task { [weak self] in
        for await chunk in ipc { self?.receive(chunk) }
        self?.append("IPC closed")
      }
    } catch {
      state = "failed"
      append("worklet failed: \(error)")
    }
  }

  /// Pairs from a scanned or pasted `agentoffice://pair?...` URL.
  func connect(_ input: String) { send(["t": "pair", "url": input]) }
  /// Types one HQ turn on the paired desktop.
  func sendHq(_ text: String) { send(["t": "send", "msg": ["t": "ctl-hq", "id": "i\(Int(Date().timeIntervalSince1970 * 1000))", "text": text]]) }
  func forget() { UserDefaults.standard.removeObject(forKey: "ctlPaired"); send(["t": "forget"]) }

  func suspend() {
    send(["t": "suspend"])
    worklet?.suspend(linger: 5000)
    append("suspend (linger 5 s)")
  }

  func resume() {
    worklet?.resume()
    send(["t": "resume"])
    append("resume")
  }

  func terminate() {
    ipc?.close()
    worklet?.terminate()
    worklet = nil
    ipc = nil
    state = "stopped"
  }

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
      switch t {
      case "log": append(obj["line"] as? String ?? "")
      case "status": state = obj["state"] as? String ?? state
      case "fatal": state = "fatal"; append("FATAL \(obj["error"] as? String ?? "")")
      case "ready": if let seed = obj["seed"] as? String { UserDefaults.standard.set(seed, forKey: "ctlSeed") }
      case "paired": if let paired = obj["paired"] as? [String: Any] { UserDefaults.standard.set(paired, forKey: "ctlPaired"); append("paired with \(paired["name"] as? String ?? "?")") }
      case "recv":
        let msg = obj["msg"] as? [String: Any] ?? [:]
        append("recv \(msg["t"] as? String ?? "?")")
      default: break
      }
    }
  }

  private func append(_ line: String) {
    logger.notice("\(line, privacy: .public)")
    lines.append(line)
    if lines.count > 500 { lines.removeFirst(lines.count - 500) }
  }
}

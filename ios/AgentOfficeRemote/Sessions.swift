import SwiftUI

// MARK: - Project screen

struct ProjectView: View {
  @ObservedObject var link: WorkletModel
  let projectId: String
  // Demo/screenshot hook: launch with `-uiSession YES` to open the first running session.
  @State private var showFirst = UserDefaults.standard.bool(forKey: "uiSession")

  private var project: Project? { link.projects.first { $0.id == projectId } }
  private var detail: ProjectDetail { link.details[projectId] ?? ProjectDetail() }
  private var running: [ProjectSession] { detail.sessions.filter { $0.running } }
  private var recent: [ProjectSession] { detail.sessions.filter { !$0.running } }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.m) {
        if !link.isOnline { OfflineBanner(text: "Offline. Showing the last known state.") }
        header
        ForEach(link.asks[projectId] ?? []) { AskCard(link: link, ask: $0) }
        NavigationLink {
          SessionView(link: link, projectId: projectId, sid: nil, title: project?.name ?? "")
        } label: {
          HStack(spacing: Space.m) {
            Image(systemName: "square.and.pencil").font(.headline).foregroundColor(Theme.accent)
              .frame(width: 38, height: 38)
              .background(Theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
              Text("New message to this project").font(.headline).foregroundColor(Theme.text)
              Text("Sent to the main session on your Mac.").font(.footnote).foregroundColor(Theme.muted)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundColor(Theme.muted)
          }
          .card()
        }
        .buttonStyle(.plain)
        if !detail.loaded {
          if detail.failed || !link.isOnline {
            EmptyState(icon: "exclamationmark.triangle", title: "Couldn't load sessions", detail: "Pull down to try again.")
          } else {
            Skeleton(height: 60); Skeleton(height: 60)
          }
        } else if detail.sessions.isEmpty {
          EmptyState(icon: "tray", title: "No sessions yet", detail: "Send a message to start one.")
        } else {
          if !running.isEmpty { sectionTitle("Running now"); ForEach(running) { row($0) } }
          if !recent.isEmpty { sectionTitle("Recent"); ForEach(recent) { row($0) } }
        }
      }
      .padding(.horizontal, Space.l).padding(.bottom, Space.xl)
    }
    .background(Theme.background)
    .refreshable { await link.refreshProject(projectId) }
    .navigationTitle(project?.name ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .navigationDestination(isPresented: $showFirst) {
      if let s = running.first ?? detail.sessions.first { SessionView(link: link, projectId: projectId, sid: s.main ? nil : s.id, title: s.title) }
    }
    .onAppear { link.requestProject(projectId) }
  }

  private var header: some View {
    HStack {
      if let p = project {
        StatusPill(status: p.status)
        Text(p.status == "working" ? (p.tool ?? "") : "").font(.footnote).foregroundColor(Theme.muted).lineLimit(1)
      }
      Spacer()
      ConnectionBadge(state: link.state)
    }
  }

  private func sectionTitle(_ key: LocalizedStringKey) -> some View {
    Text(key).font(.footnote.weight(.semibold)).foregroundColor(Theme.muted).textCase(.uppercase).padding(.top, Space.s)
  }

  private func row(_ s: ProjectSession) -> some View {
    NavigationLink {
      SessionView(link: link, projectId: projectId, sid: s.main ? nil : s.id, title: s.title)
    } label: {
      HStack(spacing: Space.m) {
        Circle().fill(s.running ? Theme.working : Theme.idle.opacity(0.5)).frame(width: 9, height: 9)
        VStack(alignment: .leading, spacing: 3) {
          Text(s.title.isEmpty ? String(localized: "Untitled session") : s.title)
            .font(.subheadline.weight(.medium)).foregroundColor(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
          Text(s.running ? String(localized: "Running") : relativeTime(s.date)).font(.caption).foregroundColor(s.running ? Theme.working : Theme.muted)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundColor(Theme.muted)
      }
      .card()
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Approval card

struct AskCard: View {
  @ObservedObject var link: WorkletModel
  let ask: Ask
  @State private var reply = ""

  private var working: Bool { link.busy.contains("answer:\(ask.id)") }
  private var title: LocalizedStringKey {
    switch ask.kind {
    case "question": return "Your agent has a question"
    case "plan": return "Approve this plan?"
    default: return "Approval needed"
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.m) {
      HStack(spacing: Space.s) {
        Image(systemName: ask.kind == "question" ? "questionmark.bubble.fill" : "lock.shield.fill").foregroundColor(Theme.approval)
        Text(title).font(.headline)
        Spacer()
        if working { ProgressView().scaleEffect(0.8) }
      }
      if ask.tool != nil || ask.detail != nil {
        VStack(alignment: .leading, spacing: 4) {
          if let tool = ask.tool { Text(tool).font(.caption.weight(.semibold)).foregroundColor(Theme.approval) }
          if let d = ask.detail { Text(d).font(.system(.footnote, design: .monospaced)).foregroundColor(Theme.text).lineLimit(6) }
        }
        .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.background.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
      }
      if !ask.options.isEmpty {
        VStack(spacing: Space.s) {
          ForEach(ask.options, id: \.key) { o in
            Button { link.answer(ask, ["option": o.key]) } label: { Text(o.label).frame(maxWidth: .infinity) }
              .buttonStyle(AskButton(filled: false, tint: Theme.accent))
          }
        }
      } else if ask.kind == "question" {
        HStack(spacing: Space.s) {
          TextField("Your answer", text: $reply)
            .padding(.horizontal, Space.m).padding(.vertical, 10)
            .background(Theme.background.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
          Button("Send") { link.answer(ask, ["text": reply]); reply = "" }
            .buttonStyle(AskButton(filled: true, tint: Theme.accent))
            .disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty)
        }
      } else {
        HStack(spacing: Space.s) {
          Button { link.answer(ask, ["decision": "deny"]); UIImpactFeedbackGenerator(style: .light).impactOccurred() } label: {
            Text("Deny").frame(maxWidth: .infinity)
          }.buttonStyle(AskButton(filled: false, tint: Theme.danger))
          Button { link.answer(ask, ["decision": "allow"]); UINotificationFeedbackGenerator().notificationOccurred(.success) } label: {
            Text("Approve").frame(maxWidth: .infinity)
          }.buttonStyle(AskButton(filled: true, tint: Theme.working))
        }
      }
    }
    .disabled(working)
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.approval.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.approval.opacity(0.45), lineWidth: 1))
  }
}

struct AskButton: ButtonStyle {
  let filled: Bool
  let tint: Color
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.semibold))
      .foregroundColor(filled ? Theme.background : tint)
      .padding(.vertical, 11).padding(.horizontal, Space.m)
      .background(filled ? tint : tint.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.chip + 2, style: .continuous))
      .opacity(configuration.isPressed ? 0.7 : 1)
  }
}

// MARK: - Live session

private enum SessionRow: Identifiable {
  case item(HQItem)
  case steps([HQItem])
  var id: String {
    switch self {
    case .item(let i): return i.id
    case .steps(let list): return "steps-" + (list.first?.id ?? "")
    }
  }
}

struct SessionView: View {
  @ObservedObject var link: WorkletModel
  let projectId: String
  let sid: String?
  let title: String
  @State private var draft = ""
  @FocusState private var focused: Bool

  private var stream: Stream { link.streams[WorkletModel.streamKey(projectId, sid)] ?? Stream() }
  private var project: Project? { link.projects.first { $0.id == projectId } }
  private var canStop: Bool { project?.status == "working" || project?.status == "approval" }

  /// Runs of three or more tool steps collapse into one compact line.
  private var rows: [SessionRow] {
    var out: [SessionRow] = []
    var run: [HQItem] = []
    func flush() {
      if run.count >= 3 { out.append(.steps(run)) } else { out.append(contentsOf: run.map { .item($0) }) }
      run = []
    }
    for it in stream.items { if it.kind == "tool" { run.append(it) } else { flush(); out.append(.item(it)) } }
    flush()
    return out
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(spacing: 6) {
          if !link.isOnline { OfflineBanner(text: "Offline. Messages can't be sent right now.").padding(.bottom, Space.s) }
          if stream.items.isEmpty {
            if stream.ended != nil && link.isOnline {
              StartingRow(text: stream.ended == "no-session" ? "Waiting for this session to start." : "Reconnecting to the session.")
            } else if stream.received {
              EmptyState(icon: "bubble.left.and.bubble.right", title: "Nothing here yet", detail: "Send a message to get this session going.")
            } else if link.isOnline { Skeleton(height: 44); Skeleton(height: 44) }
          }
          ForEach(rows) { row in
            switch row {
            case .item(let i):
              ItemRow(item: i, failed: i.toolId.flatMap { stream.toolResults[$0] } ?? false, done: i.toolId.map { stream.toolResults[$0] != nil } ?? false)
            case .steps(let list): StepsRow(items: list, results: stream.toolResults)
            }
          }
          if project?.status == "working" && (link.asks[projectId] ?? []).isEmpty { TypingRow() }
          Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, Space.l).padding(.top, Space.s)
      }
      .scrollDismissesKeyboardIfAvailable()
      .onChange(of: stream.items.count) { _ in withAnimation { proxy.scrollTo("end") } }
      .onChange(of: link.asks[projectId]?.count ?? 0) { _ in withAnimation { proxy.scrollTo("end") } }
      .onAppear { proxy.scrollTo("end") }
    }
    .background(Theme.background)
    .navigationTitle(title.isEmpty ? (project?.name ?? "") : title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .toolbar {
      ToolbarItem(placement: .navigationBarTrailing) {
        if canStop {
          Button { link.stop(projectId); UIImpactFeedbackGenerator(style: .medium).impactOccurred() } label: {
            Label("Stop", systemImage: "stop.fill").font(.footnote.weight(.semibold)).foregroundColor(Theme.danger)
          }
          .disabled(link.busy.contains("stop:\(projectId)"))
        } else { ConnectionBadge(state: link.state) }
      }
    }
    .safeAreaInset(edge: .bottom) { bottom }
    .onAppear { link.watch(projectId, sid: sid); link.requestProject(projectId) }
    .onDisappear { link.unwatch(projectId, sid: sid) }
  }

  private var bottom: some View {
    VStack(spacing: Space.s) {
      ForEach(link.asks[projectId] ?? []) { AskCard(link: link, ask: $0) }
      if let issue = link.sendIssue[projectId] {
        HStack(spacing: Space.s) {
          Image(systemName: "exclamationmark.circle")
          Text(Self.reason(issue.reason)).font(.footnote).lineLimit(2)
          Spacer(minLength: 0)
          Button("Retry") { link.retrySend(projectId) }.foregroundColor(Theme.accent)
          Button("Delete") { link.dismissIssue(projectId) }.foregroundColor(Theme.muted)
        }
        .font(.footnote.weight(.medium)).foregroundColor(Theme.danger)
        .padding(Space.m).background(Theme.danger.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
      }
      composer
    }
    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
    .background(Theme.background.opacity(0.96))
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: Space.s) {
      TextField("Message this project", text: $draft, axis: .vertical)
        .lineLimit(1...5).focused($focused)
        .padding(.horizontal, Space.m).padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.stroke))
      Button {
        link.sendToProject(projectId, draft); draft = ""
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      } label: {
        Group {
          if link.busy.contains("send:\(projectId)") { ProgressView().tint(Theme.background) }
          else { Image(systemName: "arrow.up").font(.headline.weight(.bold)) }
        }
        .foregroundColor(canSend ? Theme.background : Theme.muted)
        .frame(width: 40, height: 40)
        .background(canSend ? Theme.accent : Theme.card, in: Circle())
      }
      .disabled(!canSend)
    }
  }

  private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && link.isOnline }

  static func reason(_ r: String) -> String {
    switch r {
    case "offline": return String(localized: "Not sent, offline")
    case "busy": return String(localized: "Your agent is busy right now")
    case "locked": return String(localized: "This session is locked on your Mac")
    case "not-running": return String(localized: "This project isn't running")
    case "rate-limited": return String(localized: "Too many messages, slow down")
    case "too-large": return String(localized: "Message is too long")
    case "empty": return String(localized: "Message is empty")
    case "not-allowed": return String(localized: "Not allowed")
    default: return String(localized: "Couldn't send")
    }
  }
}

/// A collapsed run of tool steps.
struct StepsRow: View {
  let items: [HQItem]
  let results: [String: Bool]
  var body: some View {
    let failed = items.contains { $0.toolId.flatMap { results[$0] } ?? false }
    let allDone = items.allSatisfy { $0.toolId.map { results[$0] != nil } ?? false }
    HStack(spacing: 6) {
      Image(systemName: failed ? "xmark.circle.fill" : (allDone ? "checkmark.circle.fill" : "gearshape.fill"))
        .foregroundColor(failed ? Theme.danger : (allDone ? Theme.working : Theme.muted))
      Text("\(items.count) steps · \(items.last?.text ?? "")").lineLimit(1)
    }
    .font(.caption).foregroundColor(Theme.muted)
    .padding(.horizontal, 10).padding(.vertical, 5)
    .background(Theme.card, in: Capsule())
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// "HQ (or a session) is starting": a quiet spinner row instead of an empty screen.
struct StartingRow: View {
  let text: LocalizedStringKey
  var body: some View {
    HStack(spacing: Space.m) {
      ProgressView()
      Text(text).font(.subheadline).foregroundColor(Theme.muted)
      Spacer(minLength: 0)
    }
    .card()
  }
}

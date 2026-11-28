import SwiftUI

struct ContentView: View {
  @ObservedObject var link: WorkletModel
  @State private var tab = UserDefaults.standard.integer(forKey: "uiTab")

  var body: some View {
    Group {
      if link.hasPairing {
        TabView(selection: $tab) {
          OfficeView(link: link).tabItem { Label("Office", systemImage: "building.2.fill") }.tag(0)
            .badge(link.projects.filter { $0.status == "approval" }.count)
          HQView(link: link).tabItem { Label("HQ", systemImage: "bubble.left.and.bubble.right.fill") }.tag(1)
          ReportsView(link: link).tabItem { Label("Reports", systemImage: "doc.text.fill") }.tag(2)
          SettingsView(link: link).tabItem { Label("Settings", systemImage: "gearshape.fill") }.tag(3)
        }
        .tint(Theme.accent)
        .transition(.opacity)
      } else {
        OnboardingView(link: link).transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.35), value: link.hasPairing)
    .preferredColorScheme(.dark)
    .onChange(of: link.hasPairing) { paired in
      if paired { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }
  }
}

// MARK: - Shared pieces

struct EmptyState: View {
  let icon: String
  let title: LocalizedStringKey
  let detail: LocalizedStringKey
  var body: some View {
    VStack(spacing: Space.m) {
      ZStack {
        Circle().fill(Theme.accent.opacity(0.12)).frame(width: 84, height: 84)
        Image(systemName: icon).font(.system(size: 34, weight: .medium)).foregroundColor(Theme.accent)
      }
      Text(title).font(.headline)
      Text(detail).font(.subheadline).foregroundColor(Theme.muted).multilineTextAlignment(.center)
    }
    .padding(Space.xl).frame(maxWidth: .infinity).padding(.top, 60)
  }
}

struct Skeleton: View {
  @State private var on = false
  var height: CGFloat = 78
  var body: some View {
    RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
      .fill(Theme.card).frame(height: height)
      .opacity(on ? 0.45 : 1)
      .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true } }
  }
}

struct OfflineBanner: View {
  let text: LocalizedStringKey
  var body: some View {
    HStack(spacing: Space.s) {
      Image(systemName: "wifi.slash")
      Text(text).font(.footnote.weight(.medium))
      Spacer()
    }
    .foregroundColor(Theme.approval).padding(Space.m)
    .background(Theme.approval.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
  }
}

// MARK: - Office

struct OfficeView: View {
  @ObservedObject var link: WorkletModel

  private var sorted: [Project] {
    let rank = ["approval": 0, "working": 1, "idle": 2]
    return link.projects.sorted { (rank[$0.status] ?? 3, $0.name) < (rank[$1.status] ?? 3, $1.name) }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: Space.m) {
          if !link.isOnline && link.hasView { OfflineBanner(text: "Offline. Showing the last known state.") }
          if link.hasView {
            summary
            if link.projects.isEmpty {
              EmptyState(icon: "tray", title: "No projects yet", detail: "Projects you open in Agent Office show up here.")
            } else {
              ForEach(sorted) { ProjectCard(project: $0) }
            }
          } else if link.isOnline || link.state == "connecting" || link.state == "starting" {
            Skeleton(height: 64); Skeleton(); Skeleton()
          } else {
            EmptyState(icon: "wifi.slash", title: "Can't reach your Mac", detail: "Make sure Agent Office is running on your Mac. This screen updates by itself.")
          }
        }
        .padding(.horizontal, Space.l).padding(.bottom, Space.xl)
      }
      .background(Theme.background)
      .navigationTitle("Office")
      .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ConnectionBadge(state: link.state) } }
    }
  }

  private var summary: some View {
    let working = link.projects.reduce(0) { $0 + $1.working }
    let approvals = link.projects.filter { $0.status == "approval" }.count
    return HStack(spacing: Space.m) {
      tile(value: working, label: "Working", color: Theme.working)
      tile(value: approvals, label: "Need approval", color: Theme.approval)
      tile(value: link.projects.count, label: "Projects", color: Theme.accent)
    }
  }

  private func tile(value: Int, label: LocalizedStringKey, color: Color) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text("\(value)").font(.title2.weight(.bold).monospacedDigit()).foregroundColor(color)
      Text(label).font(.caption).foregroundColor(Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
    }
    .card()
  }
}

struct ProjectCard: View {
  let project: Project

  private var icon: String {
    switch project.status {
    case "working": return "waveform"
    case "approval": return "hand.raised.fill"
    default: return "moon.zzz.fill"
    }
  }
  private var engine: String {
    switch project.engine {
    case "agy": return "Antigravity"
    case "commandcode": return "Command Code"
    case "opencode": return "OpenCode"
    default: return "Claude"
    }
  }

  var body: some View {
    let c = Theme.color(for: project.status)
    HStack(alignment: .top, spacing: Space.m) {
      Image(systemName: icon).font(.headline).foregroundColor(c).frame(width: 38, height: 38)
        .background(c.opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(project.name).font(.headline).lineLimit(1)
          Spacer(minLength: Space.s)
          StatusPill(status: project.status)
        }
        Text("\(engine) · \(project.sessions) sessions · \(project.working) working").font(.footnote).foregroundColor(Theme.muted)
        if project.status == "approval" {
          Label("Waiting for your approval on the Mac", systemImage: "lock.shield").font(.footnote.weight(.medium)).foregroundColor(Theme.approval)
        } else if let tool = project.tool, project.status == "working" {
          Label(tool, systemImage: "terminal").font(.footnote).foregroundColor(Theme.muted).lineLimit(1)
        } else if project.attention == "done" {
          Label("Finished", systemImage: "checkmark.circle.fill").font(.footnote).foregroundColor(Theme.working)
        }
      }
    }
    .card()
  }
}

// MARK: - HQ chat

struct HQView: View {
  @ObservedObject var link: WorkletModel
  @State private var draft = ""
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 6) {
            if !link.isOnline { OfflineBanner(text: "Offline. Orders can't be sent right now.").padding(.bottom, Space.s) }
            if link.hqItems.isEmpty && link.outbox.isEmpty {
              EmptyState(icon: "bubble.left.and.bubble.right", title: "Talk to HQ", detail: "Send an order and follow HQ's replies here.")
            }
            ForEach(link.hqItems) { item in ItemRow(item: item, failed: item.toolId.flatMap { link.toolResults[$0] } ?? false, done: item.toolId.map { link.toolResults[$0] != nil } ?? false) }
            ForEach(link.outbox) { m in OutRow(message: m, retry: { link.retry(m.id) }, discard: { link.discard(m.id) }) }
            if link.hqStatus == "working" { TypingRow() }
            Color.clear.frame(height: 1).id("end")
          }
          .padding(.horizontal, Space.l).padding(.top, Space.s)
        }
        .scrollDismissesKeyboardIfAvailable()
        .onChange(of: link.hqItems.count) { _ in withAnimation { proxy.scrollTo("end") } }
        .onChange(of: link.outbox.count) { _ in withAnimation { proxy.scrollTo("end") } }
        .onAppear { proxy.scrollTo("end") }
      }
      .background(Theme.background)
      .navigationTitle("HQ")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ConnectionBadge(state: link.state) } }
      .safeAreaInset(edge: .bottom) { composer }
    }
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: Space.s) {
      TextField("Message HQ", text: $draft, axis: .vertical)
        .lineLimit(1...5).focused($focused)
        .padding(.horizontal, Space.m).padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.stroke))
      Button {
        link.sendHq(draft); draft = ""
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      } label: {
        Image(systemName: "arrow.up").font(.headline.weight(.bold))
          .foregroundColor(canSend ? Theme.background : Theme.muted)
          .frame(width: 40, height: 40)
          .background(canSend ? Theme.accent : Theme.card, in: Circle())
      }
      .disabled(!canSend)
      .animation(.easeInOut(duration: 0.15), value: canSend)
    }
    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
    .background(Theme.background.opacity(0.96))
  }

  private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

extension View {
  @ViewBuilder func scrollDismissesKeyboardIfAvailable() -> some View {
    if #available(iOS 16.0, *) { self.scrollDismissesKeyboard(.interactively) } else { self }
  }
}

struct Bubble: View {
  let text: String
  let mine: Bool
  var tint: Color? = nil
  var body: some View {
    HStack {
      if mine { Spacer(minLength: 48) }
      Text(Self.markdown(text)).font(.body)
        .foregroundColor(mine ? Theme.background : Theme.text)
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(tint ?? (mine ? Theme.accent : Theme.card), in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
        .textSelection(.enabled)
      if !mine { Spacer(minLength: 48) }
    }
  }
  static func markdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
  }
}

struct ItemRow: View {
  let item: HQItem
  let failed: Bool
  let done: Bool
  var body: some View {
    switch item.kind {
    case "user", "command": Bubble(text: item.text, mine: true)
    case "assistant": Bubble(text: item.text, mine: false)
    case "error": Bubble(text: item.text, mine: false, tint: Theme.danger.opacity(0.25))
    case "tool":
      HStack(spacing: 6) {
        Image(systemName: failed ? "xmark.circle.fill" : (done ? "checkmark.circle.fill" : "gearshape.fill"))
          .foregroundColor(failed ? Theme.danger : (done ? Theme.working : Theme.muted))
        Text(item.text).lineLimit(1)
      }
      .font(.caption).foregroundColor(Theme.muted)
      .padding(.horizontal, 10).padding(.vertical, 5)
      .background(Theme.card, in: Capsule())
      .frame(maxWidth: .infinity, alignment: .leading)
    default:
      Text(item.text).font(.caption).foregroundColor(Theme.muted).frame(maxWidth: .infinity)
    }
  }
}

struct OutRow: View {
  let message: OutMessage
  let retry: () -> Void
  let discard: () -> Void
  var body: some View {
    VStack(alignment: .trailing, spacing: 3) {
      Bubble(text: message.text, mine: true, tint: message.status == .rejected ? Theme.danger.opacity(0.8) : Theme.accent.opacity(message.status == .delivered ? 1 : 0.7))
      HStack(spacing: 4) {
        switch message.status {
        case .sending: ProgressView().scaleEffect(0.6); Text("Sending")
        case .queued: Image(systemName: "clock"); Text("Queued on your Mac")
        case .delivered: Image(systemName: "checkmark"); Text("Delivered")
        case .rejected:
          Image(systemName: "exclamationmark.circle"); Text(Self.reason(message.reason))
          Button("Retry", action: retry).foregroundColor(Theme.accent)
          Button("Delete", action: discard).foregroundColor(Theme.muted)
        }
      }
      .font(.caption2).foregroundColor(message.status == .rejected ? Theme.danger : Theme.muted)
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
  static func reason(_ r: String?) -> String {
    switch r {
    case "offline": return String(localized: "Not sent, offline")
    case "busy": return String(localized: "HQ is busy")
    case "rate-limited": return String(localized: "Too many messages, slow down")
    case "no-hq": return String(localized: "HQ isn't available")
    case "empty": return String(localized: "Message is empty")
    case "too-large": return String(localized: "Message is too long")
    case "not-allowed": return String(localized: "Not allowed")
    default: return String(localized: "Couldn't send")
    }
  }
}

struct TypingRow: View {
  @State private var phase = 0
  let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()
  var body: some View {
    HStack(spacing: 5) {
      ForEach(0..<3) { i in Circle().fill(Theme.muted).frame(width: 7, height: 7).opacity(phase == i ? 1 : 0.35) }
    }
    .padding(.horizontal, 14).padding(.vertical, 13)
    .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
    .frame(maxWidth: .infinity, alignment: .leading)
    .onReceive(timer) { _ in phase = (phase + 1) % 3 }
  }
}

// MARK: - Reports

struct ReportsView: View {
  @ObservedObject var link: WorkletModel
  // Demo/screenshot hook: launch with `-uiReportDetail YES` to open the first report.
  @State private var showFirst = UserDefaults.standard.bool(forKey: "uiReportDetail")

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: Space.m) {
          if !link.reportsLoaded {
            if link.isOnline { Skeleton(); Skeleton(); Skeleton() }
            else { EmptyState(icon: "wifi.slash", title: "Can't reach your Mac", detail: "Reports load when you are back online.") }
          } else if link.reports.isEmpty {
            EmptyState(icon: "doc.text", title: "No reports yet", detail: "Reports from your agents will appear here.")
          } else {
            ForEach(link.reports) { r in
              NavigationLink { ReportDetail(report: r) } label: { ReportRow(report: r) }.buttonStyle(.plain)
            }
          }
        }
        .padding(.horizontal, Space.l).padding(.bottom, Space.xl)
      }
      .background(Theme.background)
      .refreshable { await link.refreshReports() }
      .navigationDestination(isPresented: $showFirst) { if let r = link.reports.first { ReportDetail(report: r) } }
      .navigationTitle("Reports")
      .toolbar { ToolbarItem(placement: .navigationBarTrailing) { ConnectionBadge(state: link.state) } }
    }
  }
}

struct ReportRow: View {
  let report: Report
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(report.project).font(.caption.weight(.semibold)).foregroundColor(Theme.accent)
        Spacer()
        Text(relativeTime(report.date)).font(.caption).foregroundColor(Theme.muted)
      }
      Text(report.title).font(.headline).foregroundColor(Theme.text).multilineTextAlignment(.leading)
      Text(report.summary).font(.subheadline).foregroundColor(Theme.muted).lineLimit(2).multilineTextAlignment(.leading)
    }
    .card()
  }
}

struct ReportDetail: View {
  let report: Report
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.m) {
        Text(report.project).font(.subheadline.weight(.semibold)).foregroundColor(Theme.accent)
        Text(report.title).font(.title2.weight(.bold))
        Text(report.date.formatted(.dateTime.day().month(.abbreviated).year().hour().minute().locale(Locale(identifier: Bundle.main.preferredLocalizations.first ?? "en")))).font(.footnote).foregroundColor(Theme.muted)
        Text(Bubble.markdown(report.summary)).font(.body).textSelection(.enabled)
      }
      .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Theme.background)
    .navigationBarTitleDisplayMode(.inline)
  }
}

// MARK: - Settings

struct SettingsView: View {
  @ObservedObject var link: WorkletModel
  @State private var confirm = false

  private var version: String {
    let i = Bundle.main.infoDictionary
    return "\(i?["CFBundleShortVersionString"] as? String ?? "?") (\(i?["CFBundleVersion"] as? String ?? "?"))"
  }

  var body: some View {
    NavigationStack {
      List {
        Section("Desktop") {
          row("Name", link.paired?.name ?? "-")
          HStack { Text("Connection"); Spacer(); ConnectionBadge(state: link.state) }
        }
        Section {
          Button("Unpair this Mac", role: .destructive) { confirm = true }
        } footer: { Text("Removes the pairing from this iPhone. Scan a new QR code to pair again.") }
        Section("About") {
          row("Version", version)
          NavigationLink("Diagnostics") { DiagnosticsView(link: link) }
        }
      }
      .scrollContentBackground(.hidden)
      .background(Theme.background)
      .navigationTitle("Settings")
      .confirmationDialog("Unpair from this Mac?", isPresented: $confirm, titleVisibility: .visible) {
        Button("Unpair", role: .destructive) { link.unpair() }
      }
    }
  }

  private func row(_ title: LocalizedStringKey, _ value: String) -> some View {
    HStack { Text(title); Spacer(); Text(value).foregroundColor(Theme.muted) }
  }
}

struct DiagnosticsView: View {
  @ObservedObject var link: WorkletModel
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 4) {
        if let f = link.fatalError { Text(f).font(.system(.caption, design: .monospaced)).foregroundColor(Theme.danger).textSelection(.enabled) }
        ForEach(Array(link.lines.enumerated()), id: \.offset) { _, l in
          Text(l).font(.system(.caption, design: .monospaced)).foregroundColor(Theme.muted).textSelection(.enabled)
        }
      }
      .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(Theme.background)
    .navigationTitle("Diagnostics")
    .navigationBarTitleDisplayMode(.inline)
  }
}

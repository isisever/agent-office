import SwiftUI

extension Color {
  init(hex: UInt32) {
    self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
  }
}

enum Space { static let xs: CGFloat = 4, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24 }
enum Radius { static let card: CGFloat = 18, bubble: CGFloat = 20, chip: CGFloat = 10 }

enum Theme {
  static let text = Color(hex: 0xFAF9F5)
  static let muted = Color(hex: 0xC2C0B6)
  static let background = Color(hex: 0x141413)
  static let card = Color(hex: 0x262624)
  static let cardHi = Color(hex: 0x32312F)
  static let stroke = Color.white.opacity(0.07)
  static let accent = Color(hex: 0xD97757)
  static let working = Color(hex: 0x8CC26A)
  static let approval = Color(hex: 0xE5A84D)
  static let idle = Color(hex: 0x8A8982)
  static let danger = Color(hex: 0xE5484D)

  static func color(for status: String) -> Color {
    switch status {
    case "working": return working
    case "approval": return approval
    default: return idle
    }
  }
}

struct CardStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.stroke, lineWidth: 1))
  }
}

extension View {
  func card() -> some View { modifier(CardStyle()) }
}

/// Colored dot plus label for a project or HQ status.
struct StatusPill: View {
  let status: String
  var body: some View {
    let c = Theme.color(for: status)
    HStack(spacing: 6) {
      Circle().fill(c).frame(width: 7, height: 7)
      Text(label).font(.caption.weight(.semibold)).foregroundColor(c)
    }
    .padding(.horizontal, 10).padding(.vertical, 5)
    .background(c.opacity(0.14), in: Capsule())
  }
  private var label: LocalizedStringKey {
    switch status {
    case "working": return "Working"
    case "approval": return "Needs approval"
    default: return "Idle"
    }
  }
}

/// Online / offline indicator for the link to the desktop.
struct ConnectionBadge: View {
  let state: String
  var body: some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 8, height: 8)
      Text(label).font(.caption.weight(.medium)).foregroundColor(.secondary)
    }
  }
  private var color: Color {
    switch state {
    case "online": return Theme.working
    case "connecting", "pairing", "starting": return Theme.approval
    default: return Theme.danger
    }
  }
  private var label: LocalizedStringKey {
    switch state {
    case "online": return "Online"
    case "connecting", "starting": return "Connecting"
    case "pairing": return "Pairing"
    case "suspended": return "Paused"
    case "failed": return "Error"
    default: return "Offline"
    }
  }
}

func relativeTime(_ date: Date) -> String {
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .short
  return f.localizedString(for: date, relativeTo: Date())
}

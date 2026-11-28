import SwiftUI

@main
struct AgentOfficeRemoteApp: App {
  @StateObject private var link = WorkletModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      ContentView(link: link)
        .preferredColorScheme(.dark)
        .onAppear { link.start() }
    }
    .onChange(of: scenePhase) { phase in
      switch phase {
      case .background: link.suspend()
      case .active: link.resume()
      default: break
      }
    }
  }
}

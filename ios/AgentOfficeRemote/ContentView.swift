import SwiftUI

struct ContentView: View {
  @ObservedObject var link: WorkletModel
  @State private var code = ""

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Text("Worklet").font(.headline)
          Spacer()
          Text(link.state).font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
        }
        if let fatal = link.fatalError {
          ScrollView { Text(fatal).font(.system(.caption, design: .monospaced)).foregroundStyle(.red).textSelection(.enabled) }
            .frame(maxHeight: 220)
        }
        Button("Start worklet") { link.start() }
          .buttonStyle(.bordered)
        TextField("Pairing URI or 5 words", text: $code)
          .textFieldStyle(.roundedBorder)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        Button("Connect") { link.connect(code) }
          .buttonStyle(.borderedProminent)
          .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 4) {
            ForEach(Array(link.lines.enumerated()), id: \.offset) { _, line in
              Text(line).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
          }
        }
      }
      .padding()
      .navigationTitle("Agent Office Remote")
    }
    .onAppear {
      link.start()
      // spike/testing aid: `simctl launch ... -pairCode word-word-word-word-word` connects without typing
      if let preset = UserDefaults.standard.string(forKey: "pairCode"), !preset.isEmpty {
        code = preset
        link.connect(preset)
      }
    }
  }
}

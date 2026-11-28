import SwiftUI
import Speech
import AVFoundation

/// Speech-to-text for the message inputs. Uses Apple's Speech framework with the phone's current locale,
/// on-device when supported. Partial results are written into the bound draft text; sending stays with the normal send button.
@MainActor
final class Dictation: ObservableObject {
  @Published private(set) var isListening = false
  @Published var message: String?

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var starting = false      // auth callbacks pending: a second tap must not start twice
  private var generation = 0         // bumped on every stop: late results of an older run are ignored

  func toggle(text: Binding<String>) {
    if isListening { stop(); return }
    guard !starting else { return }
    starting = true
    message = nil
    let gen = generation
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard self.generation == gen else { self.starting = false; return }
        guard status == .authorized else { self.starting = false; self.message = String(localized: "Speech recognition isn't allowed. Turn it on in Settings."); return }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
          DispatchQueue.main.async {
            guard self.generation == gen else { self.starting = false; return }
            guard granted else { self.starting = false; self.message = String(localized: "Microphone access isn't allowed. Turn it on in Settings."); return }
            self.start(text: text)
          }
        }
      }
    }
  }

  func stop() {
    generation += 1
    starting = false
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.cancel()
    request = nil; task = nil
    isListening = false
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func start(text: Binding<String>) {
    starting = false
    let gen = generation
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable else {
      message = String(localized: "Dictation isn't available for this language right now."); return
    }
    let base = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      let input = engine.inputNode
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in req.append(buffer) }
      engine.prepare()
      try engine.start()
    } catch {
      stop(); message = String(localized: "Couldn't start the microphone."); return
    }
    request = req
    isListening = true
    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.generation == gen, self.isListening else { return }
        if let result {
          let spoken = result.bestTranscription.formattedString
          text.wrappedValue = base.isEmpty ? spoken : base + " " + spoken
        }
        if error != nil || result?.isFinal == true { if self.isListening { self.stop() } }
      }
    }
  }
}

/// Microphone button for the composer. Tap to start dictating into `text`, tap again to stop.
struct DictationButton: View {
  @Binding var text: String
  @ObservedObject var dictation: Dictation

  var body: some View {
    Button {
      dictation.toggle(text: $text)
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    } label: {
      Image(systemName: dictation.isListening ? "stop.fill" : "mic.fill").font(.headline)
        .foregroundColor(dictation.isListening ? Theme.background : Theme.muted)
        .frame(width: 40, height: 40)
        .background(dictation.isListening ? Theme.danger : Theme.card, in: Circle())
    }
    .accessibilityLabel(Text(dictation.isListening ? "Stop dictation" : "Dictate"))
    .onDisappear { if dictation.isListening { dictation.stop() } }
    .alert("Dictation", isPresented: Binding(get: { dictation.message != nil }, set: { if !$0 { dictation.message = nil } })) {
      Button("OK", role: .cancel) {}
    } message: { Text(dictation.message ?? "") }
  }
}

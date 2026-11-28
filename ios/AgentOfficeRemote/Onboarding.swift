import AVFoundation
import SwiftUI
import UIKit

// MARK: - Camera access

@MainActor
final class CameraAccess: ObservableObject {
  enum Status { case unknown, authorized, denied, unavailable }
  @Published var status: Status = .unknown

  func refresh() {
    guard AVCaptureDevice.default(for: .video) != nil else { status = .unavailable; return }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: status = .authorized
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { ok in Task { @MainActor in self.status = ok ? .authorized : .denied } }
    default: status = .denied
    }
  }
}

// MARK: - QR scanner

struct ScannerView: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  func makeUIViewController(context: Context) -> ScannerController { let c = ScannerController(); c.onCode = onCode; return c }
  func updateUIViewController(_ c: ScannerController, context: Context) { c.onCode = onCode }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: (String) -> Void = { _ in }
  private let session = AVCaptureSession()
  private var preview: AVCaptureVideoPreviewLayer?
  private var lastScan = Date.distantPast

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let layer = AVCaptureVideoPreviewLayer(session: session)
    layer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(layer)
    preview = layer
  }

  override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); preview?.frame = view.bounds }
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    DispatchQueue.global(qos: .userInitiated).async { [session] in if !session.isRunning { session.startRunning() } }
  }
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    DispatchQueue.global(qos: .userInitiated).async { [session] in if session.isRunning { session.stopRunning() } }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard Date().timeIntervalSince(lastScan) > 1.5,
          let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
    lastScan = Date()
    onCode(text)
  }
}

// MARK: - Onboarding: one screen, camera only

struct OnboardingView: View {
  @ObservedObject var link: WorkletModel
  @StateObject private var camera = CameraAccess()
  @State private var wrongCode = false
  @State private var pulse = false

  private var pairing: Bool { link.state == "pairing" }

  var body: some View {
    ZStack {
      Theme.background.ignoresSafeArea()
      switch camera.status {
      case .authorized: ScannerView(onCode: handle).ignoresSafeArea()
      case .unavailable:
        VStack(spacing: Space.m) {
          Image(systemName: "camera.metering.unknown").font(.system(size: 44)).foregroundColor(Theme.muted)
          Text("No camera available on this device").font(.callout).foregroundColor(Theme.muted)
        }
      default: Color.clear
      }
      if camera.status == .authorized || camera.status == .unavailable { frame }
      VStack {
        header
        Spacer()
        footer
      }
      .padding(Space.l)
      if camera.status == .denied { permissionDenied }
    }
    .preferredColorScheme(.dark)
    .onAppear { camera.refresh(); withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { pulse = true } }
  }

  private func handle(_ text: String) {
    guard !pairing else { return }
    if text.hasPrefix("agentoffice://pair") {
      wrongCode = false
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      link.connect(text)
    } else {
      wrongCode = true
    }
  }

  private var header: some View {
    VStack(spacing: Space.s) {
      Image(systemName: "qrcode.viewfinder").font(.title.weight(.semibold)).foregroundColor(Theme.accent)
      Text("Pair with Agent Office on your Mac").font(.title3.weight(.semibold)).multilineTextAlignment(.center)
      Text("Point the camera at the QR code shown in Agent Office.").font(.subheadline).foregroundColor(Theme.muted).multilineTextAlignment(.center)
    }
    .padding(Space.l)
    .frame(maxWidth: .infinity)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
  }

  private var frame: some View {
    GeometryReader { geo in
      let side = min(geo.size.width, geo.size.height) * 0.62
      CornerBrackets()
        .stroke(pairing ? Theme.working : Theme.accent, style: StrokeStyle(lineWidth: 5, lineCap: .round))
        .frame(width: side, height: side)
        .scaleEffect(pulse && !pairing ? 1.04 : 1)
        .position(x: geo.size.width / 2, y: geo.size.height / 2)
    }
    .allowsHitTesting(false)
  }

  @ViewBuilder private var footer: some View {
    if pairing {
      HStack(spacing: Space.m) {
        ProgressView().tint(Theme.accent)
        VStack(alignment: .leading, spacing: 2) {
          Text("Pairing with your Mac…").font(.subheadline.weight(.semibold))
          Text("Keep Agent Office open on your Mac.").font(.footnote).foregroundColor(Theme.muted)
        }
        Spacer()
        Button("Cancel") { link.cancelPairing() }.font(.subheadline.weight(.semibold)).foregroundColor(Theme.accent)
      }
      .padding(Space.l).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    } else if let error = link.pairError {
      errorCard(title: Self.title(error), detail: Self.detail(error)) { link.cancelPairing() }
    } else if wrongCode {
      errorCard(title: String(localized: "Not an Agent Office code"), detail: String(localized: "Scan the pairing QR code shown in Agent Office on your Mac.")) { wrongCode = false }
    } else if !link.networkUp {
      errorCard(title: String(localized: "You're offline"), detail: String(localized: "Connect to the internet or Wi-Fi to pair."), action: nil) {}
    }
  }

  private func errorCard(title: String, detail: String, action: String? = String(localized: "Try again"), onTap: @escaping () -> Void) -> some View {
    HStack(alignment: .top, spacing: Space.m) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundColor(Theme.approval)
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.subheadline.weight(.semibold))
        Text(detail).font(.footnote).foregroundColor(Theme.muted)
      }
      Spacer(minLength: 0)
      if let action { Button(action, action: onTap).font(.subheadline.weight(.semibold)).foregroundColor(Theme.accent) }
    }
    .padding(Space.l).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
  }

  private var permissionDenied: some View {
    VStack(spacing: Space.l) {
      Image(systemName: "camera.fill").font(.system(size: 48)).foregroundColor(Theme.accent)
      Text("Camera access is off").font(.title3.weight(.semibold))
      Text("Agent Office Remote needs the camera to scan the pairing QR code.").font(.subheadline).foregroundColor(Theme.muted).multilineTextAlignment(.center)
      Button {
        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      } label: {
        Text("Open Settings").font(.headline).foregroundColor(Theme.background)
          .padding(.horizontal, Space.xl).padding(.vertical, Space.m).background(Theme.accent, in: Capsule())
      }
    }
    .padding(Space.xl).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background)
  }

  static func title(_ code: String) -> String {
    switch code {
    case "expired": return String(localized: "Code expired")
    case "bad-proof": return String(localized: "Wrong code")
    case "declined": return String(localized: "Pairing declined")
    default: return String(localized: "Couldn't pair")
    }
  }
  static func detail(_ code: String) -> String {
    switch code {
    case "expired": return String(localized: "The code timed out or your Mac couldn't be reached. Show a new QR code and try again.")
    case "bad-proof": return String(localized: "This code doesn't match your Mac. Scan the code that is showing now.")
    case "declined": return String(localized: "Your Mac declined the request.")
    default: return String(localized: "Check that your Mac is online and try again.")
    }
  }
}

struct CornerBrackets: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let l: CGFloat = r.width * 0.22
    let c: CGFloat = 22
    for (sx, sy, x, y) in [(1.0, 1.0, r.minX, r.minY), (-1.0, 1.0, r.maxX, r.minY), (1.0, -1.0, r.minX, r.maxY), (-1.0, -1.0, r.maxX, r.maxY)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
      p.move(to: CGPoint(x: x, y: y + sy * l))
      p.addLine(to: CGPoint(x: x, y: y + sy * c))
      p.addQuadCurve(to: CGPoint(x: x + sx * c, y: y), control: CGPoint(x: x, y: y))
      p.addLine(to: CGPoint(x: x + sx * l, y: y))
    }
    return p
  }
}

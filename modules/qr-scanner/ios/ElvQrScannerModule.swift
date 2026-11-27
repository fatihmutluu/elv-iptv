@preconcurrency import ExpoModulesCore
import Foundation

#if os(iOS)
import AVFoundation
import UIKit

private struct SendablePromiseBox: @unchecked Sendable {
  let promise: Promise
}

private final class QrViewfinderOverlayView: UIView {
  private let scrimLayer = CAShapeLayer()
  private let cornersLayer = CAShapeLayer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    backgroundColor = .clear

    scrimLayer.fillColor = UIColor(red: 10.0 / 255.0, green: 11.0 / 255.0, blue: 15.0 / 255.0, alpha: 0.56).cgColor
    scrimLayer.fillRule = .evenOdd
    layer.addSublayer(scrimLayer)

    cornersLayer.strokeColor = UIColor.white.cgColor
    cornersLayer.fillColor = UIColor.clear.cgColor
    cornersLayer.lineWidth = 3.0
    cornersLayer.lineCap = .round
    cornersLayer.lineJoin = .round
    layer.addSublayer(cornersLayer)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }

    let side = min(max(min(bounds.width, bounds.height) * 0.62, 180.0), 280.0)
    let cutoutRect = CGRect(
      x: (bounds.width - side) * 0.5,
      y: (bounds.height - side) * 0.5,
      width: side,
      height: side
    )

    let outerPath = UIBezierPath(rect: bounds)
    let innerPath = UIBezierPath(roundedRect: cutoutRect, cornerRadius: 16.0)
    outerPath.append(innerPath)
    scrimLayer.frame = bounds
    scrimLayer.path = outerPath.cgPath

    let arm: CGFloat = 24.0
    let r: CGFloat = 14.0
    let minX = cutoutRect.minX
    let maxX = cutoutRect.maxX
    let minY = cutoutRect.minY
    let maxY = cutoutRect.maxY

    let bracketPath = UIBezierPath()
    // Top-left corner
    bracketPath.move(to: CGPoint(x: minX, y: minY + arm))
    bracketPath.addLine(to: CGPoint(x: minX, y: minY + r))
    bracketPath.addQuadCurve(to: CGPoint(x: minX + r, y: minY), controlPoint: CGPoint(x: minX, y: minY))
    bracketPath.addLine(to: CGPoint(x: minX + arm, y: minY))
    // Top-right corner
    bracketPath.move(to: CGPoint(x: maxX - arm, y: minY))
    bracketPath.addLine(to: CGPoint(x: maxX - r, y: minY))
    bracketPath.addQuadCurve(to: CGPoint(x: maxX, y: minY + r), controlPoint: CGPoint(x: maxX, y: minY))
    bracketPath.addLine(to: CGPoint(x: maxX, y: minY + arm))
    // Bottom-right corner
    bracketPath.move(to: CGPoint(x: maxX, y: maxY - arm))
    bracketPath.addLine(to: CGPoint(x: maxX, y: maxY - r))
    bracketPath.addQuadCurve(to: CGPoint(x: maxX - r, y: maxY), controlPoint: CGPoint(x: maxX, y: maxY))
    bracketPath.addLine(to: CGPoint(x: maxX - arm, y: maxY))
    // Bottom-left corner
    bracketPath.move(to: CGPoint(x: minX + arm, y: maxY))
    bracketPath.addLine(to: CGPoint(x: minX + r, y: maxY))
    bracketPath.addQuadCurve(to: CGPoint(x: minX, y: maxY - r), controlPoint: CGPoint(x: minX, y: maxY))
    bracketPath.addLine(to: CGPoint(x: minX, y: maxY - arm))

    cornersLayer.frame = bounds
    cornersLayer.path = bracketPath.cgPath
  }
}

private final class CaptureSessionRunner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
  let captureSession = AVCaptureSession()

  private let sessionQueue = DispatchQueue(
    label: "io.github.fatihmutluu.elv.qrscanner.session",
    qos: .userInitiated
  )
  private var captureDevice: AVCaptureDevice?
  private var metadataOutput: AVCaptureMetadataOutput?
  private var stoppedOnQueue = false

  var onTorchAvailabilityChanged: (@MainActor @Sendable (Bool) -> Void)?
  var onCodeDetected: (@MainActor @Sendable (String) -> Void)?
  var onFailure: (@MainActor @Sendable () -> Void)?

  func configureAndStart() {
    sessionQueue.async { [weak self] in
      guard let self, !self.stoppedOnQueue else { return }

      let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        ?? AVCaptureDevice.default(for: .video)
      guard let camera = device, let input = try? AVCaptureDeviceInput(device: camera) else {
        self.stoppedOnQueue = true
        let notifyFailure = self.onFailure
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            notifyFailure?()
          }
        }
        return
      }

      self.captureSession.beginConfiguration()
      if self.captureSession.canSetSessionPreset(.high) {
        self.captureSession.sessionPreset = .high
      }

      guard self.captureSession.canAddInput(input) else {
        self.captureSession.commitConfiguration()
        self.stoppedOnQueue = true
        let notifyFailure = self.onFailure
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            notifyFailure?()
          }
        }
        return
      }
      self.captureSession.addInput(input)

      let output = AVCaptureMetadataOutput()
      guard self.captureSession.canAddOutput(output) else {
        self.captureSession.commitConfiguration()
        self.stoppedOnQueue = true
        let notifyFailure = self.onFailure
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            notifyFailure?()
          }
        }
        return
      }
      self.captureSession.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: self.sessionQueue)
      if output.availableMetadataObjectTypes.contains(.qr) {
        output.metadataObjectTypes = [.qr]
      }
      self.captureSession.commitConfiguration()

      self.captureDevice = camera
      self.metadataOutput = output

      let hasTorch = camera.hasTorch
      let notifyTorch = self.onTorchAvailabilityChanged
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          notifyTorch?(hasTorch)
        }
      }

      if !self.stoppedOnQueue && !self.captureSession.isRunning {
        self.captureSession.startRunning()
      }
    }
  }

  func setTorch(enabled: Bool) {
    sessionQueue.async { [weak self] in
      guard let self, let device = self.captureDevice, device.hasTorch else { return }
      if (try? device.lockForConfiguration()) != nil {
        device.torchMode = enabled ? .on : .off
        device.unlockForConfiguration()
      }
    }
  }

  func stop() {
    sessionQueue.async { [weak self] in
      self?.stopOnQueue()
    }
  }

  private func stopOnQueue() {
    stoppedOnQueue = true
    if let device = captureDevice, device.hasTorch, device.torchMode != .off {
      if (try? device.lockForConfiguration()) != nil {
        device.torchMode = .off
        device.unlockForConfiguration()
      }
    }
    metadataOutput?.setMetadataObjectsDelegate(nil, queue: nil)
    if captureSession.isRunning {
      captureSession.stopRunning()
    }
    for input in captureSession.inputs {
      captureSession.removeInput(input)
    }
    for output in captureSession.outputs {
      captureSession.removeOutput(output)
    }
    metadataOutput = nil
    captureDevice = nil
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !stoppedOnQueue else { return }
    for case let readable as AVMetadataMachineReadableCodeObject in metadataObjects {
      guard readable.type == .qr,
            let raw = readable.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty
      else {
        continue
      }
      stopOnQueue()
      let notifyCode = onCodeDetected
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          notifyCode?(raw)
        }
      }
      return
    }
  }
}

private final class QrScannerViewController: UIViewController {
  var onResult: (@MainActor (String?) -> Void)?

  private let sessionRunner = CaptureSessionRunner()
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var didEmitToCoordinator = false
  private var torchEnabled = false

  private let overlayView = QrViewfinderOverlayView()
  private let torchButton = UIButton(type: .system)
  private let closeButton = UIButton(type: .system)

  override var preferredStatusBarStyle: UIStatusBarStyle {
    .lightContent
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 10.0 / 255.0, green: 11.0 / 255.0, blue: 15.0 / 255.0, alpha: 1.0)

    let preview = AVCaptureVideoPreviewLayer(session: sessionRunner.captureSession)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    previewLayer = preview

    overlayView.frame = view.bounds
    overlayView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(overlayView)

    configureChromeButtons()

    sessionRunner.onTorchAvailabilityChanged = { [weak self] hasTorch in
      guard let self else { return }
      self.torchButton.isHidden = !hasTorch
      self.updatePreviewRotationAngle()
    }
    sessionRunner.onCodeDetected = { [weak self] payload in
      self?.emitResultOnce(payload, haptic: true)
    }
    sessionRunner.onFailure = { [weak self] in
      self?.emitResultOnce(nil, haptic: false)
    }
    sessionRunner.configureAndStart()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
    updatePreviewRotationAngle()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil {
      stopSessionAsync()
      emitResultOnce(nil, haptic: false)
    }
  }

  func stopSessionAsync() {
    torchEnabled = false
    sessionRunner.stop()
  }

  private func configureChromeButtons() {
    let chromeFill = UIColor(red: 10.0 / 255.0, green: 11.0 / 255.0, blue: 15.0 / 255.0, alpha: 0.72)
    let chromeBorder = UIColor.white.withAlphaComponent(0.18).cgColor

    for button in [torchButton, closeButton] {
      button.translatesAutoresizingMaskIntoConstraints = false
      button.backgroundColor = chromeFill
      button.tintColor = .white
      button.layer.cornerRadius = 22.0
      button.layer.borderWidth = 1.0
      button.layer.borderColor = chromeBorder
      button.clipsToBounds = true
      view.addSubview(button)
    }

    torchButton.isHidden = true
    torchButton.setImage(UIImage(systemName: "flashlight.off.fill"), for: .normal)
    torchButton.accessibilityLabel = "Toggle flashlight"
    torchButton.addTarget(self, action: #selector(handleTorchTapped), for: .touchUpInside)

    closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
    closeButton.accessibilityLabel = "Close QR scanner"
    closeButton.addTarget(self, action: #selector(handleCancelTapped), for: .touchUpInside)

    NSLayoutConstraint.activate([
      torchButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 14.0),
      torchButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16.0),
      torchButton.widthAnchor.constraint(equalToConstant: 44.0),
      torchButton.heightAnchor.constraint(equalToConstant: 44.0),

      closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 14.0),
      closeButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16.0),
      closeButton.widthAnchor.constraint(equalToConstant: 44.0),
      closeButton.heightAnchor.constraint(equalToConstant: 44.0),
    ])
  }

  private func updatePreviewRotationAngle() {
    guard let connection = previewLayer?.connection else { return }
    let orientation = view.window?.windowScene?.interfaceOrientation ?? .portrait
    let angle: CGFloat
    switch orientation {
    case .portrait:
      angle = 90.0
    case .landscapeLeft:
      angle = 180.0
    case .landscapeRight:
      angle = 0.0
    case .portraitUpsideDown:
      angle = 270.0
    default:
      angle = 90.0
    }
    if connection.isVideoRotationAngleSupported(angle) {
      connection.videoRotationAngle = angle
    }
  }

  @objc private func handleCancelTapped() {
    stopSessionAsync()
    emitResultOnce(nil, haptic: false)
  }

  @objc private func handleTorchTapped() {
    let nextEnabled = !torchEnabled
    torchEnabled = nextEnabled
    torchButton.setImage(
      UIImage(systemName: nextEnabled ? "flashlight.on.fill" : "flashlight.off.fill"),
      for: .normal
    )
    torchButton.tintColor = nextEnabled
      ? UIColor(red: 250.0 / 255.0, green: 204.0 / 255.0, blue: 21.0 / 255.0, alpha: 1.0)
      : .white
    sessionRunner.setTorch(enabled: nextEnabled)
  }

  @MainActor
  private func emitResultOnce(_ payload: String?, haptic: Bool) {
    guard !didEmitToCoordinator else { return }
    didEmitToCoordinator = true
    if haptic {
      let generator = UINotificationFeedbackGenerator()
      generator.notificationOccurred(.success)
    }
    let callback = onResult
    onResult = nil
    callback?(payload)
  }
}

@MainActor
private final class QrScannerCoordinator: NSObject, UIAdaptivePresentationControllerDelegate {
  static let shared = QrScannerCoordinator()

  private var activePromiseBox: SendablePromiseBox?
  private weak var activeController: QrScannerViewController?
  private var isStartingScan = false

  static func isCameraAvailable() -> Bool {
    UIImagePickerController.isSourceTypeAvailable(.camera)
      || AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
  }

  func startScan(promiseBox: SendablePromiseBox) {
    guard !isStartingScan, activeController == nil, activePromiseBox == nil else {
      promiseBox.promise.resolve(nil)
      return
    }
    guard Self.isCameraAvailable() else {
      promiseBox.promise.resolve(nil)
      return
    }

    isStartingScan = true
    activePromiseBox = promiseBox

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      presentScanner()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        Task { @MainActor in
          QrScannerCoordinator.shared.handlePermissionResult(granted: granted)
        }
      }
    case .denied, .restricted:
      finishScan(with: nil)
    @unknown default:
      finishScan(with: nil)
    }
  }

  func cancelActiveScan() {
    if let controller = activeController {
      completeWithControllerDismiss(controller: controller, payload: nil)
    } else if activePromiseBox != nil {
      finishScan(with: nil)
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    activeController?.stopSessionAsync()
    finishScan(with: nil)
  }

  private func handlePermissionResult(granted: Bool) {
    guard isStartingScan, activePromiseBox != nil else { return }
    guard granted else {
      finishScan(with: nil)
      return
    }
    presentScanner()
  }

  private func presentScanner() {
    guard isStartingScan, activePromiseBox != nil else { return }
    guard let presenter = Self.topViewController(), presenter.presentedViewController == nil else {
      finishScan(with: nil)
      return
    }

    let controller = QrScannerViewController()
    controller.modalPresentationStyle = .fullScreen
    controller.presentationController?.delegate = self
    controller.onResult = { [weak self, weak controller] payload in
      guard let self, let controller else { return }
      self.completeWithControllerDismiss(controller: controller, payload: payload)
    }

    activeController = controller
    isStartingScan = false
    presenter.present(controller, animated: true)
    if controller.presentingViewController == nil && presenter.presentedViewController !== controller {
      controller.stopSessionAsync()
      finishScan(with: nil)
    }
  }

  private func completeWithControllerDismiss(controller: QrScannerViewController, payload: String?) {
    controller.stopSessionAsync()
    if controller.presentingViewController != nil && !controller.isBeingDismissed {
      controller.dismiss(animated: true) { [weak self] in
        self?.finishScan(with: payload)
      }
    } else {
      finishScan(with: payload)
    }
  }

  private func finishScan(with payload: String?) {
    isStartingScan = false
    activeController = nil
    let box = activePromiseBox
    activePromiseBox = nil
    box?.promise.resolve(payload)
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    let keyWindow = activeScene?.windows.first { $0.isKeyWindow } ?? activeScene?.windows.first
    var current = keyWindow?.rootViewController
    while let presented = current?.presentedViewController, !presented.isBeingDismissed {
      current = presented
    }
    return current
  }
}

/// Expo native module presenting an in-app QR code camera scanner on iOS and iPadOS (`#510`).
public final class ElvQrScannerModule: Module, @unchecked Sendable {
  public func definition() -> ModuleDefinition {
    Name("ElvQrScanner")

    Function("isAvailable") { () -> Bool in
      self.runSyncOnMain {
        QrScannerCoordinator.isCameraAvailable()
      }
    }

    AsyncFunction("scan") { (promise: Promise) in
      let box = SendablePromiseBox(promise: promise)
      MainActor.assumeIsolated {
        QrScannerCoordinator.shared.startScan(promiseBox: box)
      }
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          QrScannerCoordinator.shared.cancelActiveScan()
        }
      }
    }
  }

  private func runSyncOnMain<T: Sendable>(_ block: @escaping @MainActor @Sendable () -> T) -> T {
    if Thread.isMainThread {
      return MainActor.assumeIsolated {
        block()
      }
    }
    return DispatchQueue.main.sync {
      MainActor.assumeIsolated {
        block()
      }
    }
  }
}
#else
/// tvOS no-op stub keeping tvOS 18.0 builds completely free of iOS-only camera symbols (`#510`).
public final class ElvQrScannerModule: Module, @unchecked Sendable {
  public func definition() -> ModuleDefinition {
    Name("ElvQrScanner")

    Function("isAvailable") { () -> Bool in
      false
    }

    AsyncFunction("scan") { () -> String? in
      nil
    }
  }
}
#endif

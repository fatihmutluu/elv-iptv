#if os(iOS)
import UIKit

/// Non-interactive full-bleed black root view controller hosting video layers on an external HDMI/AirPlay display (`#258`).
@MainActor
final class AetherExternalDisplayViewController: UIViewController {
  let videoContainerView = UIView(frame: .zero)

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.isUserInteractionEnabled = false

    videoContainerView.backgroundColor = .black
    videoContainerView.isUserInteractionEnabled = false
    videoContainerView.clipsToBounds = true
    videoContainerView.frame = view.bounds
    videoContainerView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(videoContainerView)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    videoContainerView.frame = view.bounds
  }

  override var prefersStatusBarHidden: Bool {
    true
  }

  override var prefersHomeIndicatorAutoHidden: Bool {
    true
  }
}

/// `UIWindowSceneDelegate` for `UIWindowSceneSessionRoleExternalDisplayNonInteractive` (`#258`).
/// Primary application scenes stay on Expo's `SceneDelegate` (`ExpoAppSceneDelegate`), which owns window creation,
/// React Native startup, and deep/universal link forwarding under Expo SDK 58+.
@objc(AetherExternalDisplaySceneDelegate)
@MainActor
final class AetherExternalDisplaySceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var sceneId: String?
  private var hostViewController: AetherExternalDisplayViewController?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let id = session.persistentIdentifier
    sceneId = id

    let controller = AetherExternalDisplayViewController()
    controller.loadViewIfNeeded()

    let externalWindow = UIWindow(windowScene: windowScene)
    externalWindow.backgroundColor = .black
    externalWindow.isUserInteractionEnabled = false
    externalWindow.rootViewController = controller
    externalWindow.isHidden = false

    hostViewController = controller
    window = externalWindow

    AetherExternalDisplayManager.shared.registerExternalScene(
      id: id,
      containerView: controller.videoContainerView
    )
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    let id = sceneId ?? scene.session.persistentIdentifier
    AetherExternalDisplayManager.shared.unregisterExternalScene(id: id)
    sceneId = nil
    window?.isHidden = true
    window?.rootViewController = nil
    window = nil
    hostViewController = nil
  }
}
#endif

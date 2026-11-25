#if os(iOS)
import UIKit

/// Primary `UIWindowSceneDelegate` preserving Expo `AppDelegate`'s root `UIWindow` and `elviptv://` deep links
/// when `UIApplicationSceneManifest` enables dedicated external display scenes on iOS/iPadOS (`#258`).
@objc(AetherPrimaryWindowSceneDelegate)
@MainActor
final class AetherPrimaryWindowSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    attachAppDelegateWindowIfNeeded(to: windowScene)
    forwardOpenURLContexts(connectionOptions.urlContexts)
    forwardUserActivities(connectionOptions.userActivities)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    forwardOpenURLContexts(URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    forwardUserActivities([userActivity])
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    if let windowScene = scene as? UIWindowScene {
      attachAppDelegateWindowIfNeeded(to: windowScene)
    }
    AetherExternalDisplayManager.shared.handleAppBackgroundChanged(false)
    UIApplication.shared.delegate?.applicationWillEnterForeground?(UIApplication.shared)
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    if let windowScene = scene as? UIWindowScene {
      attachAppDelegateWindowIfNeeded(to: windowScene)
    }
    AetherExternalDisplayManager.shared.handleAppBackgroundChanged(false)
    UIApplication.shared.delegate?.applicationDidBecomeActive?(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    UIApplication.shared.delegate?.applicationWillResignActive?(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    AetherExternalDisplayManager.shared.handleAppBackgroundChanged(true)
    UIApplication.shared.delegate?.applicationDidEnterBackground?(UIApplication.shared)
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    if window?.windowScene === scene {
      window = nil
    }
  }

  private func attachAppDelegateWindowIfNeeded(to windowScene: UIWindowScene) {
    if let delegateWindow = UIApplication.shared.delegate?.window ?? nil {
      if delegateWindow.windowScene !== windowScene {
        delegateWindow.windowScene = windowScene
      }
      delegateWindow.frame = windowScene.coordinateSpace.bounds
      window = delegateWindow
      if !delegateWindow.isKeyWindow {
        delegateWindow.makeKeyAndVisible()
      }
      return
    }
    if window == nil {
      let created = UIWindow(windowScene: windowScene)
      window = created
      created.makeKeyAndVisible()
    }
  }

  private func forwardOpenURLContexts(_ urlContexts: Set<UIOpenURLContext>) {
    guard !urlContexts.isEmpty, let delegate = UIApplication.shared.delegate else { return }
    let app = UIApplication.shared
    for context in urlContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace,
      ]
      if let sourceApp = context.options.sourceApplication {
        options[.sourceApplication] = sourceApp
      }
      if let annotation = context.options.annotation {
        options[.annotation] = annotation
      }
      _ = delegate.application?(app, open: context.url, options: options)
    }
  }

  private func forwardUserActivities(_ activities: Set<NSUserActivity>) {
    guard !activities.isEmpty, let delegate = UIApplication.shared.delegate else { return }
    let app = UIApplication.shared
    for activity in activities {
      _ = delegate.application?(app, continue: activity, restorationHandler: { _ in })
    }
  }
}

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

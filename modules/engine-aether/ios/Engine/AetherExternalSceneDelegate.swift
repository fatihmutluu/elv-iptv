#if os(iOS)
import UIKit

/// Main-actor dispatcher delivering iOS scene deep links and universal links directly to React Native's
/// `RCTLinkingManager` via `RCTOpenURLNotification`, since `UIApplicationSceneManifest` causes
/// `RCTLinkingManager`'s legacy `AppDelegate` entry points to return `NO` (`#258`).
@MainActor
final class AetherSceneLinkDispatcher {
  static let shared = AetherSceneLinkDispatcher()

  private var replay = SceneLinkReplay()
  private var jsLoadObserver: NSObjectProtocol?
  private var didBecomeActiveObserver: NSObjectProtocol?
  private var activeFallbackWorkItem: DispatchWorkItem?

  private init() {
    ensureJavaScriptLoadObserver()
  }

  /// Handles cold-launch URL contexts and universal-link user activities from `scene(_:willConnectTo:options:)`.
  func handleColdLaunch(urlContexts: Set<UIOpenURLContext>, userActivities: Set<NSUserActivity>) {
    ensureJavaScriptLoadObserver()
    let extracted = extractURLs(from: urlContexts, userActivities: userActivities)
    guard !extracted.isEmpty else { return }

    let immediate = replay.enqueueColdLaunchURLs(extracted)
    if !immediate.isEmpty {
      schedulePostOpenURLNotifications(immediate)
      return
    }

    if replay.hasPendingColdLaunchURLs {
      if UIApplication.shared.applicationState == .active {
        handleDidBecomeActiveFallback()
      } else {
        ensureActiveFallbackObserver()
      }
    }
  }

  /// Delivers warm `scene(_:openURLContexts:)` URLs directly to `RCTLinkingManager`.
  func handleWarmURLContexts(_ urlContexts: Set<UIOpenURLContext>) {
    guard !urlContexts.isEmpty else { return }
    let urls = replay.prepareWarmURLs(urlContexts.map { $0.url.absoluteString }.sorted())
    postOpenURLNotifications(urls)
  }

  /// Delivers warm `scene(_:continue:)` universal links (`NSUserActivityTypeBrowsingWeb`) to `RCTLinkingManager`.
  func handleWarmUserActivities(_ activities: Set<NSUserActivity>) {
    guard !activities.isEmpty else { return }
    let extracted = activities
      .compactMap {
        SceneLinkReplay.extractBrowsingWebURL(activityType: $0.activityType, webpageURL: $0.webpageURL)
      }
      .sorted()
    let urls = replay.prepareWarmURLs(extracted)
    postOpenURLNotifications(urls)
  }

  private func ensureJavaScriptLoadObserver() {
    guard !replay.isJavaScriptLoaded, jsLoadObserver == nil else { return }
    jsLoadObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name(SceneLinkReplay.javaScriptDidLoadNotificationName),
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.handleJavaScriptDidLoad()
      }
    }
  }

  private func ensureActiveFallbackObserver() {
    guard didBecomeActiveObserver == nil else { return }
    didBecomeActiveObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.handleDidBecomeActiveFallback()
      }
    }
  }

  private func handleJavaScriptDidLoad() {
    removeJavaScriptLoadObserver()
    cancelActiveFallback()
    let urls = replay.markJavaScriptLoaded()
    guard !urls.isEmpty else { return }
    schedulePostOpenURLNotifications(urls)
  }

  private func handleDidBecomeActiveFallback() {
    removeActiveFallbackObserver()
    guard replay.hasPendingColdLaunchURLs else { return }
    activeFallbackWorkItem?.cancel()
    let workItem = DispatchWorkItem { [weak self] in
      AetherBackend.onMainActor {
        guard let self else { return }
        self.activeFallbackWorkItem = nil
        let urls = self.replay.flushPendingForActiveFallback()
        self.postOpenURLNotifications(urls)
      }
    }
    activeFallbackWorkItem = workItem
    // Allow RCTJavaScriptDidLoadNotification to deliver first on cold launch; fall back once if it never fires.
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(750), execute: workItem)
  }

  private func removeJavaScriptLoadObserver() {
    if let observer = jsLoadObserver {
      NotificationCenter.default.removeObserver(observer)
      jsLoadObserver = nil
    }
  }

  private func cancelActiveFallback() {
    removeActiveFallbackObserver()
    activeFallbackWorkItem?.cancel()
    activeFallbackWorkItem = nil
  }

  private func removeActiveFallbackObserver() {
    if let observer = didBecomeActiveObserver {
      NotificationCenter.default.removeObserver(observer)
      didBecomeActiveObserver = nil
    }
  }

  private func extractURLs(
    from urlContexts: Set<UIOpenURLContext>,
    userActivities: Set<NSUserActivity>
  ) -> [String] {
    var urls = urlContexts.map { $0.url.absoluteString }.sorted()
    let activityURLs = userActivities
      .compactMap {
        SceneLinkReplay.extractBrowsingWebURL(activityType: $0.activityType, webpageURL: $0.webpageURL)
      }
      .sorted()
    urls.append(contentsOf: activityURLs)
    return urls
  }

  private func schedulePostOpenURLNotifications(_ urls: [String]) {
    guard !urls.isEmpty else { return }
    // Defer one main-queue tick so JS `Linking.addEventListener('url', ...)` mounts before delivery.
    DispatchQueue.main.async { [weak self] in
      AetherBackend.onMainActor {
        self?.postOpenURLNotifications(urls)
      }
    }
  }

  private func postOpenURLNotifications(_ urls: [String]) {
    guard !urls.isEmpty else { return }
    let notificationName = Notification.Name(SceneLinkReplay.openURLNotificationName)
    for url in urls {
      NotificationCenter.default.post(
        name: notificationName,
        object: nil,
        userInfo: [SceneLinkReplay.openURLUserInfoKey: url]
      )
    }
  }
}

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
    AetherSceneLinkDispatcher.shared.handleColdLaunch(
      urlContexts: connectionOptions.urlContexts,
      userActivities: connectionOptions.userActivities
    )
    forwardOpenURLContextsToAppDelegate(connectionOptions.urlContexts)
    forwardUserActivitiesToAppDelegate(connectionOptions.userActivities)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    AetherSceneLinkDispatcher.shared.handleWarmURLContexts(URLContexts)
    forwardOpenURLContextsToAppDelegate(URLContexts)
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    AetherSceneLinkDispatcher.shared.handleWarmUserActivities([userActivity])
    forwardUserActivitiesToAppDelegate([userActivity])
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

  private func forwardOpenURLContextsToAppDelegate(_ urlContexts: Set<UIOpenURLContext>) {
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

  private func forwardUserActivitiesToAppDelegate(_ activities: Set<NSUserActivity>) {
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

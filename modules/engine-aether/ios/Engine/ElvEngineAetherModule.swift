import AetherEngine
import Darwin
import ExpoModulesCore
import Foundation

private func resolveAppleDeviceModel() -> String {
  var sysInfo = utsname()
  uname(&sysInfo)
  let machineCapacity = MemoryLayout.size(ofValue: sysInfo.machine)
  let machine = withUnsafePointer(to: sysInfo.machine) { ptr in
    ptr.withMemoryRebound(to: CChar.self, capacity: machineCapacity) {
      String(cString: $0)
    }
  }
  if machine == "x86_64" || machine == "arm64",
     let simModel = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
     !simModel.isEmpty
  {
    return simModel
  }
  return machine
}

/// External sidecar subtitle record passed from JavaScript (`#32`, `#308`).
struct ExternalSubtitleArgs: Record {
  @Field var id: String = ""
  @Field var uri: String = ""
  @Field var label: String? = nil
  @Field var language: String? = nil
  @Field var mimeType: String? = nil
  @Field var headers: [String: String]? = nil

  init() {}

  func toDescriptor() -> ExternalSubtitleDescriptor? {
    let cleanId = id.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanUri = uri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanId.isEmpty, !cleanUri.isEmpty else { return nil }
    let cleanLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanLang = language?.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanMime = mimeType?.trimmingCharacters(in: .whitespacesAndNewlines)
    return ExternalSubtitleDescriptor(
      id: cleanId,
      uri: cleanUri,
      label: (cleanLabel?.isEmpty == false) ? cleanLabel : nil,
      language: (cleanLang?.isEmpty == false) ? cleanLang : nil,
      mimeType: (cleanMime?.isEmpty == false) ? cleanMime : nil,
      headers: headers ?? [:]
    )
  }
}

/// Live subtitle appearance record passed from JavaScript (`#32`).
struct SubtitleStyleArgs: Record {
  @Field var fontSize: String? = nil
  @Field var textColor: String? = nil
  @Field var backgroundColor: String? = nil
  @Field var edgeStyle: String? = nil
  @Field var verticalPosition: String? = nil

  init() {}

  func toOverride() -> UserSubtitleStyleOverride {
    UserSubtitleStyleOverride.fromRaw(
      fontSize: fontSize,
      textColor: textColor,
      backgroundColor: backgroundColor,
      edgeStyle: edgeStyle,
      verticalPosition: verticalPosition
    )
  }
}

/// Display Auto Frame-Rate & HDR switching policy record passed from JavaScript (`#188`, `#116`).
struct DisplaySyncArgs: Record {
  @Field var autoFrameRate: String? = nil
  @Field var autoDynamicRange: Bool? = nil

  init() {}
}

/// Flattened `LoadCommand` record sent from JavaScript (`@elv/playback`'s `bridgeNativeEngine`).
struct LoadArgs: Record {
  @Field var attempt: Int = 0
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  @Field var kind: String = "live"
  @Field var startMs: Double? = nil
  @Field var softwareAudio: Bool = false
  @Field var preferHevcOverDolbyVision: Bool = false
  @Field var filterSdhSubtitles: Bool = false
  @Field var allowLegacyTls: Bool = false
  @Field var bufferPreset: String? = nil
  @Field var dnsFamily: String? = nil
  @Field var hostOverride: String? = nil
  @Field var autoFrameRate: String? = nil
  @Field var autoDynamicRange: Bool? = nil
  @Field var displaySync: DisplaySyncArgs? = nil
  @Field var audioTrackId: String? = nil
  @Field var subtitleTrackId: ValueOrUndefined<String?> = .undefined
  @Field var secondarySubtitleTrackId: String? = nil
  @Field var externalSubtitles: [ExternalSubtitleArgs]? = nil
  @Field var subtitleStyle: SubtitleStyleArgs? = nil

  init() {}

  func toLoadRequest() -> LoadRequest {
    let trimmedAudio = audioTrackId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let subtitlePref: SubtitlePreference
    switch subtitleTrackId {
    case .undefined:
      subtitlePref = .default
    case let .value(unwrapped):
      if let raw = unwrapped?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
        subtitlePref = .selected(raw)
      } else {
        subtitlePref = .off
      }
    }
    let trimmedSecondary = secondarySubtitleTrackId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let parsedExternal = (externalSubtitles ?? []).compactMap { $0.toDescriptor() }
    let cleanStartMs = startMs.flatMap { $0.isFinite ? $0 : nil }
    let resolvedAutoFrameRate = AppleAutoFrameRateMode.parseExact(autoFrameRate ?? displaySync?.autoFrameRate)
    let resolvedAutoDynamicRange = autoDynamicRange ?? displaySync?.autoDynamicRange
    return LoadRequest(
      url: url,
      headers: headers,
      live: kind != "vod",
      startMs: cleanStartMs,
      softwareAudio: softwareAudio,
      preferHevcOverDolbyVision: preferHevcOverDolbyVision,
      filterSdhSubtitles: filterSdhSubtitles,
      allowLegacyTls: allowLegacyTls,
      audioTrackId: (trimmedAudio?.isEmpty == false) ? trimmedAudio : nil,
      subtitlePreference: subtitlePref,
      secondarySubtitleTrackId: (trimmedSecondary?.isEmpty == false) ? trimmedSecondary : nil,
      externalSubtitles: parsedExternal,
      subtitleStyle: subtitleStyle?.toOverride(),
      dnsFamily: DnsFamilyPreference.parse(dnsFamily),
      hostOverride: validateHostOverride(hostOverride),
      autoFrameRate: resolvedAutoFrameRate,
      autoDynamicRange: resolvedAutoDynamicRange,
      bufferPreset: AppleBufferPreset.parse(bufferPreset)
    )
  }
}

/// Playback metadata record passed from JavaScript to `MPNowPlayingInfoCenter` (`#413`).
struct MediaMetadataArgs: Record {
  @Field var title: String = ""
  @Field var subtitle: String? = nil
  @Field var artworkUrl: String? = nil
  @Field var kind: String = "live"
  @Field var canStepTrack: Bool = false

  init() {}

  func toNowPlayingMetadata() -> NowPlayingMetadata? {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else { return nil }
    let trimmedSubtitle = subtitle?.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedArtwork = artworkUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
    return NowPlayingMetadata(
      title: trimmedTitle,
      subtitle: (trimmedSubtitle?.isEmpty == false) ? trimmedSubtitle : nil,
      artworkUrl: (trimmedArtwork?.isEmpty == false) ? trimmedArtwork : nil,
      isLive: kind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "vod",
      canStepTrack: canStepTrack
    )
  }
}

/// Optional initial Multi-View engine configuration passed to `new Engine(options)` (`#34`).
struct AetherEngineOptionsArgs: Record {
  @Field var handleAudioFocus: Bool? = nil

  init() {}
}

private struct WeakEngineRef {
  weak var value: EngineObject?
}

/// Expo native module exposing `AetherEngine` behind the `PlayerEngine` port on tvOS, iOS and iPadOS.
public final class ElvEngineAetherModule: Module, @unchecked Sendable {
  private let enginesLock = NSLock()
  private var engineTable: [ObjectIdentifier: WeakEngineRef] = [:]
  private var engineOrder: [ObjectIdentifier] = []
  private var autoEnterPipEnabled = false
  private var thermalObserver: NSObjectProtocol?
  private var isDestroyed = false

  public func definition() -> ModuleDefinition {
    Name("ElvEngineAether")

    Events(
      "onSafeAreaInsetsChanged",
      "onHardwareKey",
      "onThermalStateChanged",
      "onPictureInPictureChanged"
    )

    OnCreate {
      AppleModuleEventHub.shared.attach(module: self)
      self.installThermalObserver()
    }

    OnStartObserving("onSafeAreaInsetsChanged") {
      AppleModuleEventHub.shared.setObservingSafeArea(true, from: self)
    }

    OnStopObserving("onSafeAreaInsetsChanged") {
      AppleModuleEventHub.shared.setObservingSafeArea(false, from: self)
    }

    OnStartObserving("onHardwareKey") {
      AppleModuleEventHub.shared.setObservingHardwareKey(true, from: self)
    }

    OnStopObserving("onHardwareKey") {
      AppleModuleEventHub.shared.setObservingHardwareKey(false, from: self)
    }

    Function("uptimeMs") { () -> Double in
      ProcessInfo.processInfo.systemUptime * 1_000.0
    }

    Function("engineVersion") { () -> String in
      AetherEngine.version
    }

    Function("deviceModel") { () -> String in
      resolveAppleDeviceModel()
    }

    Function("thermalState") { () -> String in
      mapProcessInfoThermalState(ProcessInfo.processInfo.thermalState).rawValue
    }

    Function("physicalMemoryBytes") { () -> Double in
      Double(ProcessInfo.processInfo.physicalMemory)
    }

    Function("enterPictureInPicture") { (engine: EngineObject?) -> Bool in
      self.runSyncOnMain {
        guard let target = self.resolvePipTargetEngine(preferred: engine) else {
          return false
        }
        return target.enterPictureInPicture()
      }
    }

    Function("canStartPictureInPicture") { (engine: EngineObject?) -> Bool in
      self.runSyncOnMain {
        guard let target = self.resolvePipTargetEngine(preferred: engine) else {
          return false
        }
        return target.canStartPictureInPicture()
      }
    }

    Function("setAutoEnterPictureInPicture") { (enabled: Bool, engine: EngineObject?) -> Bool in
      if engine == nil {
        self.enginesLock.withLock {
          self.autoEnterPipEnabled = enabled
        }
      }
      return self.runSyncOnMain {
        if let engine {
          return engine.setAutoEnterPictureInPicture(enabled)
        }
        let engines = self.liveEnginesNewestFirst()
        if engines.isEmpty {
          return AetherPipController.isAutoEnterSupported
        }
        var anyApplied = false
        for item in engines where item.setAutoEnterPictureInPicture(enabled) {
          anyApplied = true
        }
        return anyApplied
      }
    }

    Function("readPersistentValue") { (key: String) -> String? in
      ApplePersistentKVStore.read(key: key)
    }

    Function("writePersistentValue") { (key: String, value: String) -> Bool in
      ApplePersistentKVStore.write(key: key, value: value)
    }

    Function("writeLocalPersistentValue") { (key: String, value: String) -> Bool in
      ApplePersistentKVStore.writeLocal(key: key, value: value)
    }

    Function("persistentStorageBudgetBytes") { () -> Int in
      ApplePersistentKVStore.budgetBytes()
    }

    Function("getSafeAreaInsets") { () -> [String: Double] in
      AppleModuleEventHub.shared.currentSafeAreaInsetsDictionary()
    }

    AsyncFunction("readClipboardText") { () -> String? in
      MainActor.assumeIsolated {
        AppleSourceImport.readClipboardText()
      }
    }.runOnQueue(.main)

    AsyncFunction("pickPlaylistFile") { (promise: Promise) in
      MainActor.assumeIsolated {
        AppleSourceImport.pickPlaylistFile { result in
          switch result {
          case let .success(payload):
            promise.resolve(payload)
          case let .failure(error):
            promise.reject("E_PLAYLIST_PICK_FAILED", error.localizedDescription)
          }
        }
      }
    }.runOnQueue(.main)

    OnDestroy {
      self.removeThermalObserver()
      AppleModuleEventHub.shared.detach(module: self)
      let remaining: [EngineObject] = self.enginesLock.withLock {
        self.isDestroyed = true
        let list = self.engineTable.values.compactMap(\.value)
        self.engineTable.removeAll()
        self.engineOrder.removeAll()
        return list
      }
      for engine in remaining {
        engine.dispose()
      }
    }

    Class("Engine", EngineObject.self) {
      Constructor { (options: AetherEngineOptionsArgs?) -> EngineObject in
        let initialAutoEnterPip = self.enginesLock.withLock { self.autoEnterPipEnabled }
        let handleAudioFocus = options?.handleAudioFocus ?? true
        let instance = EngineObject(
          initialAutoEnterPip: initialAutoEnterPip,
          handleAudioFocus: handleAudioFocus
        ) { [weak self] disposed in
          self?.unregister(disposed)
        }
        self.register(instance)
        return instance
      }

      Function("load") { (engine: EngineObject, args: LoadArgs) in
        engine.load(args.toLoadRequest(), attempt: args.attempt)
      }

      Function("retry") { (engine: EngineObject, attempt: Int) in
        engine.retry(attempt)
      }

      Function("play") { (engine: EngineObject, attempt: Int) in
        engine.play(attempt)
      }

      Function("pause") { (engine: EngineObject, attempt: Int) in
        engine.pause(attempt)
      }

      Function("seek") { (engine: EngineObject, attempt: Int, positionMs: Double) in
        engine.seek(attempt, positionMs: positionMs)
      }

      Function("setSpeed") { (engine: EngineObject, attempt: Int, rate: Double) in
        engine.setSpeed(attempt, rate: rate)
      }

      Function("setMuted") { (engine: EngineObject, muted: Bool) in
        engine.setMuted(muted)
      }

      Function("setVolume") { (engine: EngineObject, volume: Double) in
        engine.setVolume(volume)
      }

      Function("setBackgroundAudioEnabled") { (engine: EngineObject, enabled: Bool) in
        engine.setBackgroundAudioEnabled(enabled)
      }

      Function("setAllowDetachedSurface") { (engine: EngineObject, enabled: Bool) in
        engine.setAllowDetachedSurface(enabled)
      }

      Function("setMediaMetadata") { (engine: EngineObject, args: MediaMetadataArgs?) in
        engine.setMediaMetadata(args?.toNowPlayingMetadata())
      }

      Function("configureMultiView") { (engine: EngineObject, handleAudioFocus: Bool) in
        engine.configureMultiView(handleAudioFocus: handleAudioFocus)
      }

      Function("selectAudioTrack") { (engine: EngineObject, attempt: Int, id: String) in
        engine.selectAudioTrack(attempt, id: id)
      }

      Function("selectSubtitleTrack") { (engine: EngineObject, attempt: Int, id: String?) in
        engine.selectSubtitleTrack(attempt, id: id)
      }

      Function("selectSecondarySubtitleTrack") { (engine: EngineObject, attempt: Int, id: String?) in
        engine.selectSecondarySubtitleTrack(attempt, id: id)
      }

      Function("addExternalSubtitle") { (engine: EngineObject, attempt: Int, args: ExternalSubtitleArgs) in
        guard let descriptor = args.toDescriptor() else { return }
        engine.addExternalSubtitle(attempt, track: descriptor)
      }

      Function("setSubtitleStyle") { (engine: EngineObject, args: SubtitleStyleArgs?) in
        engine.setSubtitleStyle(args?.toOverride())
      }

      Function("setDisplaySync") { (engine: EngineObject, autoFrameRate: String?, autoDynamicRange: Bool?) in
        engine.setDisplaySync(autoFrameRate: autoFrameRate, autoDynamicRange: autoDynamicRange)
      }

      Function("setAudioDelay") { (engine: EngineObject, attempt: Int, delayMs: Double) in
        engine.setAudioDelay(attempt, delayMs: delayMs)
      }

      Function("setSubtitleDelay") { (engine: EngineObject, attempt: Int, delayMs: Double) in
        engine.setSubtitleDelay(attempt, delayMs: delayMs)
      }

      Function("selectVideoQuality") { (engine: EngineObject, attempt: Int, id: String?) in
        engine.selectVideoQuality(attempt, id: id)
      }

      Function("stop") { (engine: EngineObject, attempt: Int) in
        engine.stop(attempt)
      }

      Function("recreate") { (engine: EngineObject, attempt: Int) in
        engine.recreate(attempt)
      }
    }

    View(AetherSurfaceView.self) {
      Prop("engine") { (view: AetherSurfaceView, engine: EngineObject?) in
        view.bind(engine)
      }

      Prop("resizeMode") { (view: AetherSurfaceView, mode: String?) in
        view.setResizeMode(mode)
      }

      Prop("subtitleBottomInsetPx") { (view: AetherSurfaceView, inset: Double?) in
        view.setSubtitleBottomInsetPx(inset)
      }

      Prop("subtitleFontFamily") { (view: AetherSurfaceView, family: String?) in
        view.setSubtitleFontFamily(family)
      }

      Prop("subtitleStyle") { (view: AetherSurfaceView, args: SubtitleStyleArgs?) in
        view.setSubtitleStyle(args?.toOverride())
      }

      Prop("osdVisible") { (view: AetherSurfaceView, visible: Bool?) in
        view.setOsdVisible(visible)
      }
    }
  }

  private func installThermalObserver() {
    let previous: NSObjectProtocol? = enginesLock.withLock {
      isDestroyed = false
      let old = thermalObserver
      thermalObserver = nil
      return old
    }
    if let previous {
      NotificationCenter.default.removeObserver(previous)
    }
    let token = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      let destroyed = self.enginesLock.withLock { self.isDestroyed }
      guard !destroyed else { return }
      let level = mapProcessInfoThermalState(ProcessInfo.processInfo.thermalState)
      self.emit(event: "onThermalStateChanged", payload: ["state": level.rawValue])
    }
    let shouldDrop: Bool = enginesLock.withLock {
      if isDestroyed {
        return true
      }
      thermalObserver = token
      return false
    }
    if shouldDrop {
      NotificationCenter.default.removeObserver(token)
    }
  }

  private func removeThermalObserver() {
    let token: NSObjectProtocol? = enginesLock.withLock {
      let old = thermalObserver
      thermalObserver = nil
      return old
    }
    if let token {
      NotificationCenter.default.removeObserver(token)
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

  private func liveEnginesNewestFirst() -> [EngineObject] {
    enginesLock.withLock {
      var alive: [EngineObject] = []
      var keptOrder: [ObjectIdentifier] = []
      for key in engineOrder {
        if let engine = engineTable[key]?.value {
          keptOrder.append(key)
          alive.append(engine)
        } else {
          engineTable.removeValue(forKey: key)
        }
      }
      engineOrder = keptOrder
      return alive.reversed()
    }
  }

  @MainActor
  private func resolvePipTargetEngine(preferred: EngineObject?) -> EngineObject? {
    if let preferred {
      return preferred
    }
    let engines = liveEnginesNewestFirst()
    if let pipReady = engines.first(where: { $0.canStartPictureInPicture() }) {
      return pipReady
    }
    if let surfaceBound = engines.first(where: { $0.hasBoundSurface }) {
      return surfaceBound
    }
    return engines.first
  }

  private func register(_ engine: EngineObject) {
    let key = ObjectIdentifier(engine)
    enginesLock.withLock {
      engineTable[key] = WeakEngineRef(value: engine)
      engineOrder.removeAll { $0 == key }
      engineOrder.append(key)
    }
  }

  private func unregister(_ engine: EngineObject) {
    let key = ObjectIdentifier(engine)
    _ = enginesLock.withLock {
      engineTable.removeValue(forKey: key)
      engineOrder.removeAll { $0 == key }
    }
  }
}

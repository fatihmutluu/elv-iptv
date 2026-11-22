import Foundation
import Network

/// Sendable snapshot of a discovered `_airplay._tcp` Bonjour receiver and its parsed TXT `model` (`#234`).
struct AirPlayDiscoveredService: Equatable, Sendable {
  let name: String
  let model: String?
}

/// Thread-safe box allowing `AetherAirPlayMonitor.deinit` to cancel `NWBrowser` without actor-isolation warnings.
private final class AirPlayBrowserHolder: @unchecked Sendable {
  private let lock = NSLock()
  private var browser: NWBrowser?

  func swap(_ next: NWBrowser?) -> NWBrowser? {
    lock.withLock {
      let previous = browser
      browser = next
      return previous
    }
  }

  var isActive: Bool {
    lock.withLock { browser != nil }
  }
}

/// Lazy `_airplay._tcp` Bonjour TXT capability probe (`#234`).
/// Runs ONLY while an `.airPlay` audio route or `AVPlayer.isExternalPlaybackActive` is active and cancels immediately otherwise.
@MainActor
final class AetherAirPlayMonitor {
  private let holder = AirPlayBrowserHolder()
  private let queue = DispatchQueue(label: "elv.aether.airplay.bonjour", qos: .utility)
  private let onServicesChanged: @MainActor @Sendable ([AirPlayDiscoveredService]) -> Void
  private var generation = 0

  init(onServicesChanged: @escaping @MainActor @Sendable ([AirPlayDiscoveredService]) -> Void) {
    self.onServicesChanged = onServicesChanged
  }

  deinit {
    if let existing = holder.swap(nil) {
      existing.browseResultsChangedHandler = nil
      existing.stateUpdateHandler = nil
      existing.cancel()
    }
  }

  func start() {
    guard !holder.isActive else { return }
    generation &+= 1
    let activeGen = generation
    let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_airplay._tcp", domain: nil)
    let browser = NWBrowser(for: descriptor, using: NWParameters())
    let onSnapshot = onServicesChanged

    browser.browseResultsChangedHandler = { [weak self] results, _ in
      var discovered: [AirPlayDiscoveredService] = []
      discovered.reserveCapacity(results.count)
      for result in results {
        guard case let .service(name: name, type: _, domain: _, interface: _) = result.endpoint else {
          continue
        }
        let model: String?
        if case let .bonjour(txtRecord) = result.metadata {
          model = parseAirPlayTxtModel(txtRecord.dictionary)
        } else {
          model = nil
        }
        discovered.append(AirPlayDiscoveredService(name: name, model: model))
      }
      let snapshot = discovered
      AetherBackend.onMainActor {
        guard let self, self.generation == activeGen, self.holder.isActive else { return }
        onSnapshot(snapshot)
      }
    }

    browser.stateUpdateHandler = { [weak self] state in
      if case let .failed(error) = state {
        NSLog("ELV_AETHER airplay Bonjour browser failed: %@", String(describing: error))
        AetherBackend.onMainActor {
          guard let self, self.generation == activeGen else { return }
          self.stop()
        }
      }
    }

    if let previous = holder.swap(browser) {
      previous.browseResultsChangedHandler = nil
      previous.stateUpdateHandler = nil
      previous.cancel()
    }
    browser.start(queue: queue)
  }

  func stop() {
    generation &+= 1
    if let existing = holder.swap(nil) {
      existing.browseResultsChangedHandler = nil
      existing.stateUpdateHandler = nil
      existing.cancel()
    }
  }
}

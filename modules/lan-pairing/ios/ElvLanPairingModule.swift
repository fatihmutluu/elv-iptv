import ExpoModulesCore
import Foundation

/// Expo native module hosting an ephemeral local-network HTTP server for phone-to-TV QR source pairing
/// (`#50`) on iOS and tvOS. Closes automatically on first valid submission, TTL expiry, `stopServer`,
/// or module `OnDestroy`.
public final class ElvLanPairingModule: Module, @unchecked Sendable {
  private let serverLock = NSLock()
  private var activeServer: LanPairingServer?

  public func definition() -> ModuleDefinition {
    Name("ElvLanPairing")

    Events("onSubmission")

    AsyncFunction("startServer") { (options: [String: Any], promise: Promise) in
      guard let token = options["token"] as? String else {
        promise.reject("E_LAN_PAIRING_INVALID_OPTIONS", "Missing pairing token")
        return
      }
      guard let html = options["html"] as? String else {
        promise.reject("E_LAN_PAIRING_INVALID_OPTIONS", "Missing pairing HTML")
        return
      }
      guard let rawTtl = options["ttlMs"] as? NSNumber else {
        promise.reject("E_LAN_PAIRING_INVALID_OPTIONS", "Missing pairing ttlMs")
        return
      }
      let ttlMs = rawTtl.intValue
      let maxBodyBytes = (options["maxBodyBytes"] as? NSNumber)?.intValue
        ?? LanPairingServer.defaultMaxBodyBytes
      let maxFailedAttempts = (options["maxFailedAttempts"] as? NSNumber)?.intValue
        ?? LanPairingServer.defaultMaxFailedAttempts

      let server = LanPairingServer(
        token: token,
        html: html,
        ttlMs: ttlMs,
        maxBodyBytes: maxBodyBytes,
        maxFailedAttempts: maxFailedAttempts
      ) { [weak self] body, contentType in
        guard let self else { return }
        var payload: [String: Any] = ["body": body]
        if let contentType, !contentType.isEmpty {
          payload["contentType"] = contentType
        }
        self.sendEvent("onSubmission", payload)
      }

      let previous = self.replaceActiveServer(with: server)
      previous?.stop()

      server.start { [weak self] result in
        switch result {
        case let .success(info):
          promise.resolve([
            "host": info.host,
            "port": info.port,
            "url": info.url,
            "expiresAtMs": info.expiresAtMs,
          ])
        case let .failure(error):
          self?.clearActiveServer(ifSameAs: server)
          promise.reject("E_LAN_PAIRING_START_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("stopServer") { () -> Void in
      self.stopActiveServer()
    }

    OnDestroy {
      self.stopActiveServer()
    }
  }

  private func replaceActiveServer(with next: LanPairingServer?) -> LanPairingServer? {
    serverLock.lock()
    defer { serverLock.unlock() }
    let previous = activeServer
    activeServer = next
    return previous
  }

  private func clearActiveServer(ifSameAs candidate: LanPairingServer) {
    serverLock.lock()
    if activeServer === candidate {
      activeServer = nil
    }
    serverLock.unlock()
  }

  private func stopActiveServer() {
    let previous = replaceActiveServer(with: nil)
    previous?.stop()
  }
}

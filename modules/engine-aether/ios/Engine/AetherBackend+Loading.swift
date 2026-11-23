import AetherEngine
import Foundation

extension AetherBackend {
  func runMediaLoad(
    plan: MediaPlan,
    fallbackOptions: EngineLoadOptions,
    serial: Int,
    currentEngine: AetherEngine
  ) {
    gateGeneration += 1
    let generation = gateGeneration
    gate.advance(to: generation)

    loadTask = Task { @MainActor [weak self] in
      guard let self, self.activeLoadSerial == serial, !Task.isCancelled else { return }
      do {
        switch plan {
        case let .hls(url, _):
          guard await self.gate.waitForClosed(before: generation),
                self.activeLoadSerial == serial,
                !Task.isCancelled
          else { return }
          let opts = self.currentLoadOptions ?? fallbackOptions
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(
            url: url,
            options: aetherOptions(opts),
            audioSourceStreamIndex: opts.audioStreamIndex
          )

        case let .vod(url, startSeconds):
          guard await self.gate.waitForClosed(before: generation),
                self.activeLoadSerial == serial,
                !Task.isCancelled
          else { return }
          let opts = self.currentLoadOptions ?? fallbackOptions
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(
            url: url,
            startPosition: startSeconds,
            options: aetherOptions(opts),
            audioSourceStreamIndex: opts.audioStreamIndex
          )

        case let .liveTs(url):
          let activeOpts = self.currentLoadOptions ?? fallbackOptions
          let session = self.sessionForLoad(allowLegacyTls: activeOpts.allowLegacyTls)
          let initialHeaders = activeOpts.httpHeaders
          let reader = LiveTsReader(
            url: url,
            headers: initialHeaders,
            generation: generation,
            gate: self.gate,
            makeTransport: { URLSessionTransport(session: session) },
            onBytesReceived: { [weak self] totalBytes in
              Self.onMainActor {
                guard let self, self.activeLoadSerial == serial else { return }
                self.onObservation?(.progress(bytesReceived: totalBytes, bufferedSeconds: nil), serial)
              }
            }
          )
          self.currentReader = reader
          let verdict = await reader.open()
          guard self.activeLoadSerial == serial, !Task.isCancelled else {
            self.closeReader(reader)
            return
          }
          switch verdict {
          case let .media(hint):
            let opts = self.currentLoadOptions ?? fallbackOptions
            self.engineLoadSerial = serial
            _ = try await currentEngine.load(
              source: .custom(reader, formatHint: hint),
              options: aetherOptions(opts),
              audioSourceStreamIndex: opts.audioStreamIndex
            )

          case .playlist:
            self.closeReader(reader)
            self.gateGeneration += 1
            let playlistGen = self.gateGeneration
            self.gate.advance(to: playlistGen)
            guard await self.gate.waitForClosed(before: playlistGen),
                  self.activeLoadSerial == serial,
                  !Task.isCancelled
            else { return }
            let hlsOpts = hlsHandoffOptions(from: self.currentLoadOptions ?? fallbackOptions)
            self.currentLoadOptions = hlsOpts
            self.currentPlan = .hls(url, live: true)
            self.engineLoadSerial = serial
            _ = try await currentEngine.load(
              url: url,
              options: aetherOptions(hlsOpts),
              audioSourceStreamIndex: hlsOpts.audioStreamIndex
            )

          case let .failed(rf):
            self.closeReader(reader)
            guard self.errorReportedSerial != serial else { return }
            self.errorReportedSerial = serial
            self.onObservation?(.failure(.reader(rf)), serial)

          case .superseded:
            self.closeReader(reader)
          }
        }
      } catch is CancellationError {
        self.closeCurrentReader()
        return
      } catch {
        let readerFault = self.currentReader?.lastFailure
        self.closeCurrentReader()
        guard self.activeLoadSerial == serial, self.errorReportedSerial != serial else { return }
        self.errorReportedSerial = serial
        if let readerFault {
          self.onObservation?(.readerFault(readerFault), serial)
        }
        if let info = currentEngine.errorInfo {
          self.onObservation?(
            .failure(.engine(kind: info.kind.rawValue, underlyingDomain: info.underlyingDomain, underlyingCode: info.underlyingCode)),
            serial
          )
        } else {
          let nsError = error as NSError
          self.onObservation?(
            .failure(.engine(kind: "sourceOpenFailed", underlyingDomain: nsError.domain, underlyingCode: nsError.code)),
            serial
          )
        }
      }
    }
  }

  func handleLiveReplayExhausted(from target: AetherEngine, serial: Int) {
    guard errorReportedSerial != serial else { return }
    let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    switch liveRecoveryPolicy.nextAction(atMs: nowMs) {
    case .coalesceInFlight:
      return
    case .escalate:
      escalateLiveSourceReset(serial: serial)
    case let .retryAfter(delayMs):
      liveRecoveryTask?.cancel()
      liveRecoveryTask = Task { @MainActor [weak self, weak target] in
        do {
          try await Task.sleep(nanoseconds: UInt64(delayMs * 1_000_000.0))
        } catch {
          return
        }
        guard let self, let target, !Task.isCancelled,
              self.engineLoadSerial == serial, self.errorReportedSerial != serial
        else { return }
        let accepted = target.retryLiveSourceRecovery()
        self.liveRecoveryPolicy.noteRetryDispatched(accepted: accepted)
        self.liveRecoveryTask = nil
        if !accepted {
          self.escalateLiveSourceReset(serial: serial)
        }
      }
    }
  }

  func escalateLiveSourceReset(serial: Int) {
    guard errorReportedSerial != serial else { return }
    liveRecoveryTask?.cancel()
    liveRecoveryTask = nil
    errorReportedSerial = serial
    forwardReaderFaultIfPresent(serial: serial)
    onObservation?(.failure(.liveSourceReset), serial)
  }

  func closeReader(_ reader: LiveTsReader) {
    reader.close()
    if currentReader === reader {
      currentReader = nil
    }
  }

  func closeCurrentReader() {
    currentReader?.close()
    currentReader = nil
  }

  func forwardReaderFaultIfPresent(serial: Int) {
    if let rf = currentReader?.lastFailure {
      onObservation?(.readerFault(rf), serial)
    }
  }

  func sessionForLoad(allowLegacyTls: Bool) -> EngineHttpSession {
    guard allowLegacyTls else { return httpSession }
    if let existing = legacyHttpSession { return existing }
    let created = EngineHttpSession(allowLegacyTls: true)
    legacyHttpSession = created
    return created
  }
}

import Foundation

/// Outcome of opening `LiveTsReader` against the live stream endpoint.
public enum ReaderOpen: Equatable, Sendable {
  case media(formatHint: String?)
  case playlist
  case failed(ReaderFailure)
  case superseded
}

/// Forward-only live MPEG-TS reader with 1,024-byte response sniffing, gate coordination, and single-drop reconnect.
public final class LiveTsReader: @unchecked Sendable {
  private final class TransportRelay: ByteTransportDelegate, @unchecked Sendable {
    let connectionId: Int
    weak var owner: LiveTsReader?

    init(connectionId: Int, owner: LiveTsReader) {
      self.connectionId = connectionId
      self.owner = owner
    }

    func transportDidReceive(status: Int, contentType: String?) {
      owner?.handleStatus(connectionId: connectionId, status: status, contentType: contentType)
    }
    func transportDidReceive(_ data: Data) {
      owner?.handleData(connectionId: connectionId, data: data)
    }
    func transportDidComplete(error: ReaderFailure?) {
      owner?.handleComplete(connectionId: connectionId, error: error)
    }
  }

  private enum Phase {
    case idle, waitingGate, sniffing, streaming, finished
  }

  private let url: URL
  private let headers: [String: String]
  private let generation: Int
  private let gate: ConnectionGate
  private let makeTransport: @Sendable () -> ByteTransport
  private let fifo = ByteFifo()
  private let lock = NSLock()

  private var phase: Phase = .idle
  private var gateAcquired = false
  private var gateClosed = false
  private var abortedByCaller = false

  private var activeConnectionId = 0
  private var activeTransport: ByteTransport?
  private var transportInFlight = false

  private var openContinuation: CheckedContinuation<ReaderOpen, Never>?
  private var sniffStatus: Int?
  private var sniffContentType: String?
  private var sniffBuffer = Data()

  private var deliveredAnyBytes = false
  private var reconnectedOnce = false
  private var reconnectRejected = false
  private var storedFailure: ReaderFailure?

  public init(
    url: URL,
    headers: [String: String],
    generation: Int,
    gate: ConnectionGate,
    makeTransport: @escaping @Sendable () -> ByteTransport
  ) {
    self.url = url
    self.headers = headers
    self.generation = generation
    self.gate = gate
    self.makeTransport = makeTransport
  }

  public var lastFailure: ReaderFailure? {
    lock.withLock { storedFailure }
  }

  /// Acquires the connection gate, sends the GET, and classifies the status + initial 1,024 bytes.
  public func open() async -> ReaderOpen {
    let canBegin: Bool = lock.withLock {
      guard phase == .idle, !abortedByCaller else { return false }
      phase = .waitingGate
      return true
    }
    guard canBegin else { return .superseded }

    let allowed = await gate.open(
      generation: generation,
      forceClose: { [weak self] in self?.abort(closeReader: true) }
    )
    guard allowed else {
      lock.withLock { phase = .finished }
      return .superseded
    }

    return await withCheckedContinuation { (continuation: CheckedContinuation<ReaderOpen, Never>) in
      var transportToStart: (ByteTransport, TransportRelay)?
      var closeGateNow = false

      lock.withLock {
        gateAcquired = true
        if abortedByCaller {
          phase = .finished
          markGateClosedLocked(&closeGateNow)
        } else {
          phase = .sniffing
          openContinuation = continuation
          transportToStart = prepareNextTransportLocked()
        }
      }

      if closeGateNow {
        gate.closed(generation: generation)
        continuation.resume(returning: .superseded)
      } else if let (transport, relay) = transportToStart {
        transport.start(url: url, headers: headers, delegate: relay)
      }
    }
  }

  /// Reads available bytes immediately from the internal FIFO (`0` on EOF, `-1` on cancel/failure).
  public func read(into buffer: UnsafeMutablePointer<UInt8>, size: Int32) -> Int32 {
    fifo.read(into: buffer, size: size)
  }

  /// Unblocks any parked `read` with `-1` and cancels the active HTTP request immediately.
  public func cancel() {
    abort(closeReader: false)
  }

  /// Closes the reader, cancels any active HTTP request, and releases the connection gate slot.
  public func close() {
    abort(closeReader: true)
  }

  private func abort(closeReader: Bool) {
    fifo.cancel()
    var transportToCancel: ByteTransport?
    var pendingOpen: CheckedContinuation<ReaderOpen, Never>?
    var closeGateNow = false

    lock.withLock {
      abortedByCaller = true
      if closeReader { phase = .finished }
      transportToCancel = activeTransport
      if closeReader { activeTransport = nil }
      pendingOpen = openContinuation
      openContinuation = nil
      sniffBuffer.removeAll(keepingCapacity: false)
      if !transportInFlight {
        markGateClosedLocked(&closeGateNow)
      }
    }

    transportToCancel?.cancel()
    if closeGateNow { gate.closed(generation: generation) }
    pendingOpen?.resume(returning: .superseded)
  }

  private func handleStatus(connectionId: Int, status: Int, contentType: String?) {
    var transportToCancel: ByteTransport?
    var openResult: (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)?
    var failStream: ReaderFailure?

    lock.withLock {
      guard connectionId == activeConnectionId, !abortedByCaller else { return }
      switch phase {
      case .sniffing:
        sniffStatus = status
        sniffContentType = contentType
        if !(200...299).contains(status) {
          let err = ReaderFailure.status(status)
          storedFailure = err
          phase = .finished
          transportToCancel = activeTransport
          openResult = popOpenLocked(.failed(err))
        } else if isHlsContentType(contentType) || hasExtM3uSignature(sniffBuffer) {
          phase = .finished
          transportToCancel = activeTransport
          sniffBuffer.removeAll(keepingCapacity: false)
          openResult = popOpenLocked(.playlist)
        } else if sniffBuffer.count >= sniffBytes {
          openResult = decideSniffLocked(completedError: nil, transportToCancel: &transportToCancel)
        }
      case .streaming:
        if !(200...299).contains(status) {
          let err = ReaderFailure.status(status)
          storedFailure = err
          reconnectRejected = true
          phase = .finished
          transportToCancel = activeTransport
          failStream = err
        } else if isProgressiveNoticeContentType(contentType) {
          storedFailure = .notice
          reconnectRejected = true
          phase = .finished
          transportToCancel = activeTransport
          failStream = .notice
        }
      case .idle, .waitingGate, .finished:
        break
      }
    }

    applyOpenSideEffects(openResult?.1)
    if let failStream { fifo.finish(failStream) }
    transportToCancel?.cancel()
    if let (cont, verdict) = openResult { cont.resume(returning: verdict) }
  }

  private func handleData(connectionId: Int, data: Data) {
    guard !data.isEmpty else { return }
    var transportToCancel: ByteTransport?
    var openResult: (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)?
    var forwardToFifo: Data?

    lock.withLock {
      guard connectionId == activeConnectionId, !abortedByCaller else { return }
      switch phase {
      case .sniffing:
        sniffBuffer.append(data)
        if sniffStatus != nil && hasExtM3uSignature(sniffBuffer) {
          phase = .finished
          transportToCancel = activeTransport
          sniffBuffer.removeAll(keepingCapacity: false)
          openResult = popOpenLocked(.playlist)
        } else if sniffStatus != nil && sniffBuffer.count >= sniffBytes {
          openResult = decideSniffLocked(completedError: nil, transportToCancel: &transportToCancel)
          if case .media = openResult?.1 {
            forwardToFifo = drainSniffBufferLocked()
          }
        }
      case .streaming:
        if !reconnectRejected {
          deliveredAnyBytes = true
          forwardToFifo = data
        }
      case .idle, .waitingGate, .finished:
        break
      }
    }

    if let forwardToFifo { fifo.write(forwardToFifo) }
    applyOpenSideEffects(openResult?.1)
    transportToCancel?.cancel()
    if let (cont, verdict) = openResult { cont.resume(returning: verdict) }
  }

  private func handleComplete(connectionId: Int, error: ReaderFailure?) {
    var openResult: (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)?
    var forwardToFifo: Data?
    var finishFifo: (shouldFinish: Bool, failure: ReaderFailure?) = (false, nil)
    var reconnectStart: (ByteTransport, TransportRelay)?
    var closeGateNow = false

    lock.withLock {
      guard connectionId == activeConnectionId else { return }
      transportInFlight = false
      activeTransport = nil

      if abortedByCaller {
        phase = .finished
        openResult = popOpenLocked(.superseded)
        markGateClosedLocked(&closeGateNow)
        return
      }

      switch phase {
      case .sniffing:
        if let error, sniffStatus == nil || sniffBuffer.isEmpty {
          storedFailure = error
          phase = .finished
          finishFifo = (true, error)
          openResult = popOpenLocked(.failed(error))
          markGateClosedLocked(&closeGateNow)
        } else {
          var unused: ByteTransport?
          openResult = decideSniffLocked(completedError: error, transportToCancel: &unused)
          if case .media = openResult?.1 {
            forwardToFifo = drainSniffBufferLocked()
            reconnectOrFinishLocked(error: error, reconnectStart: &reconnectStart, finishFifo: &finishFifo, closeGateNow: &closeGateNow)
          } else {
            if case let .failed(err) = openResult?.1 { finishFifo = (true, err) }
            markGateClosedLocked(&closeGateNow)
          }
        }
      case .streaming:
        reconnectOrFinishLocked(error: error, reconnectStart: &reconnectStart, finishFifo: &finishFifo, closeGateNow: &closeGateNow)
      case .idle, .waitingGate, .finished:
        markGateClosedLocked(&closeGateNow)
      }
    }

    if let forwardToFifo, !forwardToFifo.isEmpty { fifo.write(forwardToFifo) }
    if case .playlist = openResult?.1 { fifo.cancel() }
    if finishFifo.shouldFinish { fifo.finish(finishFifo.failure) }
    if closeGateNow { gate.closed(generation: generation) }
    if let (cont, verdict) = openResult { cont.resume(returning: verdict) }
    if let (nextTransport, relay) = reconnectStart {
      nextTransport.start(url: url, headers: headers, delegate: relay)
    }
  }

  private func reconnectOrFinishLocked(
    error: ReaderFailure?,
    reconnectStart: inout (ByteTransport, TransportRelay)?,
    finishFifo: inout (shouldFinish: Bool, failure: ReaderFailure?),
    closeGateNow: inout Bool
  ) {
    if !reconnectRejected && deliveredAnyBytes && !reconnectedOnce {
      reconnectedOnce = true
      reconnectStart = prepareNextTransportLocked()
      return
    }
    phase = .finished
    let fallback = ReaderFailure.transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
    let terminal = storedFailure ?? error ?? fallback
    if deliveredAnyBytes || error != nil || storedFailure != nil {
      storedFailure = terminal
      finishFifo = (true, terminal)
    } else {
      finishFifo = (true, nil)
    }
    markGateClosedLocked(&closeGateNow)
  }

  private func prepareNextTransportLocked() -> (ByteTransport, TransportRelay) {
    activeConnectionId += 1
    let connId = activeConnectionId
    let transport = makeTransport()
    activeTransport = transport
    transportInFlight = true
    fifo.attachTransport(transport)
    return (transport, TransportRelay(connectionId: connId, owner: self))
  }

  private func drainSniffBufferLocked() -> Data {
    let data = sniffBuffer
    deliveredAnyBytes = !data.isEmpty
    sniffBuffer.removeAll(keepingCapacity: false)
    return data
  }

  private func markGateClosedLocked(_ closeGateNow: inout Bool) {
    if gateAcquired && !gateClosed {
      gateClosed = true
      closeGateNow = true
    }
  }

  private func popOpenLocked(_ verdict: ReaderOpen) -> (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)? {
    guard let cont = openContinuation else { return nil }
    openContinuation = nil
    return (cont, verdict)
  }

  private func applyOpenSideEffects(_ verdict: ReaderOpen?) {
    switch verdict {
    case .playlist: fifo.cancel()
    case let .failed(err): fifo.finish(err)
    case .media, .superseded, .none: break
    }
  }

  private func decideSniffLocked(
    completedError: ReaderFailure?,
    transportToCancel: inout ByteTransport?
  ) -> (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)? {
    let verdict = classifyProgressive(
      contentType: sniffContentType,
      prefix: Data(sniffBuffer.prefix(sniffBytes))
    )
    switch verdict {
    case .playlist:
      phase = .finished
      transportToCancel = activeTransport
      sniffBuffer.removeAll(keepingCapacity: false)
      return popOpenLocked(.playlist)
    case .notice:
      storedFailure = .notice
      phase = .finished
      transportToCancel = activeTransport
      sniffBuffer.removeAll(keepingCapacity: false)
      return popOpenLocked(.failed(.notice))
    case let .media(hint):
      if sniffBuffer.isEmpty, let completedError {
        storedFailure = completedError
        phase = .finished
        return popOpenLocked(.failed(completedError))
      }
      phase = .streaming
      return popOpenLocked(.media(formatHint: hint))
    }
  }
}

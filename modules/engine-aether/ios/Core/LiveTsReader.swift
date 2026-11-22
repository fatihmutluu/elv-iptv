import Foundation

/// Forward-only live MPEG-TS reader with `LiveTsSniffer` open/reconnect classification, gate coordination, and a time-windowed reconnect budget.
public final class LiveTsReader: @unchecked Sendable {
  private final class TransportRelay: ByteTransportDelegate, @unchecked Sendable {
    let connectionId: Int
    weak var owner: LiveTsReader?
    init(connectionId: Int, owner: LiveTsReader) { self.connectionId = connectionId; self.owner = owner }
    func transportDidReceive(status: Int, contentType: String?) { owner?.handleStatus(connectionId: connectionId, status: status, contentType: contentType) }
    func transportDidReceive(_ data: Data) { owner?.handleData(connectionId: connectionId, data: data) }
    func transportDidComplete(error: ReaderFailure?) { owner?.handleComplete(connectionId: connectionId, error: error) }
  }

  private enum Phase { case idle, waitingGate, openingSniff, reconnectSniff, streaming, finished }

  private struct SideEffects {
    var transportToCancel: ByteTransport?
    var openResult: (CheckedContinuation<ReaderOpen, Never>, ReaderOpen)?
    var forwardToFifo: Data?
    var finishFifo: (shouldFinish: Bool, failure: ReaderFailure?) = (false, nil)
    var closeGate = false
    var reconnectStart: (ByteTransport, TransportRelay)?
    var reportProgressBytes: Int64?
  }

  private let url: URL
  private let headers: [String: String]
  private let generation: Int
  private let gate: ConnectionGate
  private let makeTransport: @Sendable () -> ByteTransport
  private let onBytesReceived: (@Sendable (Int64) -> Void)?
  private let maxReconnectsInWindow: Int
  private let reconnectWindowSeconds: TimeInterval
  private let stableStreamingResetSeconds: TimeInterval
  private let now: @Sendable () -> TimeInterval
  private let fifo = ByteFifo()
  private let lock = NSLock()
  private var phase: Phase = .idle
  private var gateAcquired = false
  private var gateClosed = false
  private var abortedByCaller = false
  private var activeConnectionId = 0
  private var activeTransport: ByteTransport?
  private var transportInFlight = false
  private var inFlightSelf: LiveTsReader?
  private var openContinuation: CheckedContinuation<ReaderOpen, Never>?
  private var sniffer = LiveTsSniffer()
  private var deliveredAnyBytes = false
  private var cumulativeBytesReceived: Int64 = 0
  private var lastProgressNotifiedAt: TimeInterval = -.infinity
  private var reconnectTimestamps: [TimeInterval] = []
  private var streamingSince: TimeInterval?
  private var reconnectRejected = false
  private var storedFailure: ReaderFailure?

  public init(
    url: URL,
    headers: [String: String],
    generation: Int,
    gate: ConnectionGate,
    makeTransport: @escaping @Sendable () -> ByteTransport,
    onBytesReceived: (@Sendable (Int64) -> Void)? = nil,
    maxReconnectsInWindow: Int = 3,
    reconnectWindowSeconds: TimeInterval = 60.0,
    stableStreamingResetSeconds: TimeInterval = 30.0,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.url = url
    self.headers = headers
    self.generation = generation
    self.gate = gate
    self.makeTransport = makeTransport
    self.onBytesReceived = onBytesReceived
    self.maxReconnectsInWindow = max(0, maxReconnectsInWindow)
    self.reconnectWindowSeconds = reconnectWindowSeconds.isFinite ? max(0.0, reconnectWindowSeconds) : 60.0
    self.stableStreamingResetSeconds = stableStreamingResetSeconds.isFinite ? max(0.0, stableStreamingResetSeconds) : 30.0
    self.now = now
  }

  deinit {
    if gateAcquired && !gateClosed { gate.closed(generation: generation) }
  }

  public var lastFailure: ReaderFailure? { lock.withLock { storedFailure } }

  /// Acquires the connection gate, sends the GET, and classifies the status + initial 1,024 bytes.
  public func open() async -> ReaderOpen {
    let canBegin: Bool = lock.withLock {
      guard phase == .idle, !abortedByCaller else { return false }
      phase = .waitingGate
      return true
    }
    guard canBegin else { return .superseded }

    let allowed = await gate.open(generation: generation, forceClose: { [weak self] in self?.abort(closeReader: true) })
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
          phase = .openingSniff
          sniffer.reset()
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
  public func read(into buffer: UnsafeMutablePointer<UInt8>, size: Int32) -> Int32 { fifo.read(into: buffer, size: size) }

  public func cancel() { abort(closeReader: false) }
  public func close() { abort(closeReader: true) }

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
      sniffer.reset()
      if !transportInFlight { markGateClosedLocked(&closeGateNow) }
    }

    transportToCancel?.cancel()
    if closeGateNow { gate.closed(generation: generation) }
    pendingOpen?.resume(returning: .superseded)
  }

  private func handleStatus(connectionId: Int, status: Int, contentType: String?) {
    var fx = SideEffects()
    lock.withLock {
      guard connectionId == activeConnectionId, !abortedByCaller else { return }
      switch phase {
      case .openingSniff, .reconnectSniff:
        applySniffDecisionLocked(sniffer.onStatus(status, contentType: contentType), isReconnect: phase == .reconnectSniff, into: &fx)
      case .streaming where !(200...299).contains(status):
        failReconnectLocked(.status(status), into: &fx)
      default:
        break
      }
    }
    flushSideEffects(fx)
  }

  private func handleData(connectionId: Int, data: Data) {
    guard !data.isEmpty else { return }
    var fx = SideEffects()
    lock.withLock {
      guard connectionId == activeConnectionId, !abortedByCaller else { return }
      cumulativeBytesReceived += Int64(data.count)
      let currentTime = now()
      if onBytesReceived != nil {
        if currentTime - lastProgressNotifiedAt >= 0.45 {
          lastProgressNotifiedAt = currentTime
          fx.reportProgressBytes = cumulativeBytesReceived
        }
      }
      switch phase {
      case .openingSniff, .reconnectSniff:
        applySniffDecisionLocked(sniffer.onData(data), isReconnect: phase == .reconnectSniff, into: &fx)
      case .streaming where !reconnectRejected:
        deliveredAnyBytes = true
        if let started = streamingSince {
          if currentTime - started >= stableStreamingResetSeconds {
            reconnectTimestamps.removeAll()
          }
        } else {
          streamingSince = currentTime
        }
        fx.forwardToFifo = data
      default:
        break
      }
    }
    flushSideEffects(fx)
  }

  private func handleComplete(connectionId: Int, error: ReaderFailure?) {
    var fx = SideEffects()
    lock.withLock {
      guard connectionId == activeConnectionId else { return }
      transportInFlight = false
      activeTransport = nil
      inFlightSelf = nil

      if abortedByCaller {
        phase = .finished
        fx.openResult = popOpenLocked(.superseded)
        markGateClosedLocked(&fx.closeGate)
        return
      }

      switch phase {
      case .openingSniff:
        applySniffDecisionLocked(sniffer.onComplete(error: error), isReconnect: false, into: &fx)
        fx.transportToCancel = nil
        if case .media = fx.openResult?.1 {
          reconnectOrFinishLocked(error: error, into: &fx)
        } else {
          markGateClosedLocked(&fx.closeGate)
        }
      case .reconnectSniff:
        applySniffDecisionLocked(sniffer.onComplete(error: error), isReconnect: true, into: &fx)
        fx.transportToCancel = nil
        if phase == .streaming {
          reconnectOrFinishLocked(error: error, into: &fx)
        } else {
          markGateClosedLocked(&fx.closeGate)
        }
      case .streaming:
        reconnectOrFinishLocked(error: error, into: &fx)
      case .idle, .waitingGate, .finished:
        markGateClosedLocked(&fx.closeGate)
      }
    }
    flushSideEffects(fx)
  }

  private func flushSideEffects(_ fx: SideEffects) {
    if let totalBytes = fx.reportProgressBytes { onBytesReceived?(totalBytes) }
    if let bytes = fx.forwardToFifo, !bytes.isEmpty { fifo.write(bytes) }
    switch fx.openResult?.1 {
    case .playlist: fifo.cancel()
    case let .failed(err): fifo.finish(err)
    case .media, .superseded, .none: break
    }
    if fx.finishFifo.shouldFinish { fifo.finish(fx.finishFifo.failure) }
    fx.transportToCancel?.cancel()
    if fx.closeGate { gate.closed(generation: generation) }
    if let (cont, verdict) = fx.openResult { cont.resume(returning: verdict) }
    if let (nextTransport, relay) = fx.reconnectStart {
      nextTransport.start(url: url, headers: headers, delegate: relay)
    }
  }

  private func applySniffDecisionLocked(_ decision: LiveTsSniffer.Decision, isReconnect: Bool, into fx: inout SideEffects) {
    switch decision {
    case .needMore:
      break
    case let .media(hint, initialBytes):
      deliveredAnyBytes = deliveredAnyBytes || !initialBytes.isEmpty
      fx.forwardToFifo = initialBytes
      phase = .streaming
      streamingSince = now()
      if !isReconnect { fx.openResult = popOpenLocked(.media(formatHint: hint)) }
    case .playlist:
      if isReconnect {
        failReconnectLocked(.transport(domain: NSURLErrorDomain, code: NSURLErrorCannotParseResponse), into: &fx)
      } else {
        phase = .finished
        fx.transportToCancel = activeTransport
        fx.openResult = popOpenLocked(.playlist)
      }
    case let .failed(err):
      if isReconnect {
        failReconnectLocked(err, into: &fx)
      } else {
        storedFailure = err
        phase = .finished
        fx.transportToCancel = activeTransport
        fx.openResult = popOpenLocked(.failed(err))
      }
    }
  }

  private func failReconnectLocked(_ err: ReaderFailure, into fx: inout SideEffects) {
    storedFailure = err
    reconnectRejected = true
    phase = .finished
    fx.transportToCancel = activeTransport
    fx.finishFifo = (true, err)
  }

  private func reconnectOrFinishLocked(error: ReaderFailure?, into fx: inout SideEffects) {
    let currentTime = now()
    streamingSince = nil
    reconnectTimestamps.removeAll { currentTime - $0 >= reconnectWindowSeconds }
    if !reconnectRejected && deliveredAnyBytes && reconnectTimestamps.count < maxReconnectsInWindow {
      reconnectTimestamps.append(currentTime)
      phase = .reconnectSniff
      sniffer.reset()
      fx.reconnectStart = prepareNextTransportLocked()
      return
    }
    phase = .finished
    let fallback = ReaderFailure.transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
    let terminal = storedFailure ?? error ?? fallback
    if deliveredAnyBytes || error != nil || storedFailure != nil {
      storedFailure = terminal
      fx.finishFifo = (true, terminal)
    } else {
      fx.finishFifo = (true, nil)
    }
    markGateClosedLocked(&fx.closeGate)
  }

  private func prepareNextTransportLocked() -> (ByteTransport, TransportRelay) {
    activeConnectionId += 1
    let transport = makeTransport()
    activeTransport = transport
    transportInFlight = true
    inFlightSelf = self
    fifo.attachTransport(transport)
    return (transport, TransportRelay(connectionId: activeConnectionId, owner: self))
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
}

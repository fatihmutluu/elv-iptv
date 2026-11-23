import Foundation

/// Locked pan direction on the tvOS Siri Remote touch surface (`#225`).
public enum PanAxis: String, Equatable, Sendable {
  case horizontal
  case vertical
}

/// Lifecycle phase emitted on `onPanGesture`.
public enum PanPhase: String, Equatable, Sendable {
  case began
  case changed
  case ended
  case cancelled
}

/// Gesture-recognizer state fed into `DirectionalPanPolicy`.
public enum PanGestureInputState: Equatable, Sendable {
  case began
  case changed
  case ended
  case cancelled
}

/// Axis-locked Siri Remote touch-surface pan event emitted to JavaScript (`#225`).
public struct DirectionalPanEvent: Equatable, Sendable {
  public let axis: PanAxis
  public let phase: PanPhase
  public let translation: Double
  public let velocity: Double

  public init(axis: PanAxis, phase: PanPhase, translation: Double, velocity: Double) {
    self.axis = axis
    self.phase = phase
    self.translation = translation
    self.velocity = velocity
  }

  /// Dictionary payload delivered through Expo Modules `emit(event: "onPanGesture", payload: ...)`.
  public func toPayload() -> [String: Any] {
    [
      "axis": axis.rawValue,
      "phase": phase.rawValue,
      "translation": translation,
      "velocity": velocity,
    ]
  }
}

/// Disambiguates Siri Remote touch-surface pans into a single locked axis (`horizontal` vs `vertical`)
/// after clearing a deadzone (`18 pt`) with a `1.35×` dominance ratio, ignoring orthogonal drift once locked (`#225`).
public struct DirectionalPanPolicy: Sendable {
  public let deadzonePoints: Double
  public let dominanceRatio: Double

  public private(set) var isEnabled: Bool
  public private(set) var lockedAxis: PanAxis?
  private var lastTranslation: Double = 0.0

  public init(
    deadzonePoints: Double = 18.0,
    dominanceRatio: Double = 1.35,
    isEnabled: Bool = false
  ) {
    self.deadzonePoints = deadzonePoints
    self.dominanceRatio = dominanceRatio
    self.isEnabled = isEnabled
  }

  /// Enables or disables pan forwarding. Disabling mid-gesture cancels the active locked pan cleanly.
  @discardableResult
  public mutating func setEnabled(_ enabled: Bool) -> DirectionalPanEvent? {
    isEnabled = enabled
    guard !enabled else { return nil }
    guard let axis = lockedAxis else {
      lastTranslation = 0.0
      return nil
    }
    let translation = lastTranslation
    lockedAxis = nil
    lastTranslation = 0.0
    return DirectionalPanEvent(axis: axis, phase: .cancelled, translation: translation, velocity: 0.0)
  }

  /// Resets gesture lock state without changing `isEnabled`.
  public mutating func reset() {
    lockedAxis = nil
    lastTranslation = 0.0
  }

  /// Processes one gesture-recognizer sample and returns a `DirectionalPanEvent` when an axis-locked event should emit.
  public mutating func update(
    state: PanGestureInputState,
    translationX: Double,
    translationY: Double,
    velocityX: Double,
    velocityY: Double
  ) -> DirectionalPanEvent? {
    guard isEnabled else {
      lockedAxis = nil
      lastTranslation = 0.0
      return nil
    }
    guard translationX.isFinite, translationY.isFinite else {
      return nil
    }
    let safeVx = velocityX.isFinite ? velocityX : 0.0
    let safeVy = velocityY.isFinite ? velocityY : 0.0

    switch state {
    case .began:
      lockedAxis = nil
      lastTranslation = 0.0
      return tryLock(dx: translationX, dy: translationY, vx: safeVx, vy: safeVy)

    case .changed:
      if let axis = lockedAxis {
        let primary = primaryValues(for: axis, dx: translationX, dy: translationY, vx: safeVx, vy: safeVy)
        lastTranslation = primary.translation
        return DirectionalPanEvent(
          axis: axis,
          phase: .changed,
          translation: primary.translation,
          velocity: primary.velocity
        )
      }
      return tryLock(dx: translationX, dy: translationY, vx: safeVx, vy: safeVy)

    case .ended:
      guard let axis = lockedAxis else {
        reset()
        return nil
      }
      let primary = primaryValues(for: axis, dx: translationX, dy: translationY, vx: safeVx, vy: safeVy)
      reset()
      return DirectionalPanEvent(
        axis: axis,
        phase: .ended,
        translation: primary.translation,
        velocity: primary.velocity
      )

    case .cancelled:
      guard let axis = lockedAxis else {
        reset()
        return nil
      }
      let primary = primaryValues(for: axis, dx: translationX, dy: translationY, vx: safeVx, vy: safeVy)
      reset()
      return DirectionalPanEvent(
        axis: axis,
        phase: .cancelled,
        translation: primary.translation,
        velocity: primary.velocity
      )
    }
  }

  private mutating func tryLock(
    dx: Double,
    dy: Double,
    vx: Double,
    vy: Double
  ) -> DirectionalPanEvent? {
    let absX = abs(dx)
    let absY = abs(dy)
    guard max(absX, absY) >= deadzonePoints else {
      return nil
    }
    if absX >= deadzonePoints && absX >= absY * dominanceRatio {
      lockedAxis = .horizontal
      lastTranslation = dx
      return DirectionalPanEvent(axis: .horizontal, phase: .began, translation: dx, velocity: vx)
    }
    if absY >= deadzonePoints && absY >= absX * dominanceRatio {
      lockedAxis = .vertical
      lastTranslation = dy
      return DirectionalPanEvent(axis: .vertical, phase: .began, translation: dy, velocity: vy)
    }
    return nil
  }

  private func primaryValues(
    for axis: PanAxis,
    dx: Double,
    dy: Double,
    vx: Double,
    vy: Double
  ) -> (translation: Double, velocity: Double) {
    switch axis {
    case .horizontal:
      return (dx, vx)
    case .vertical:
      return (dy, vy)
    }
  }
}

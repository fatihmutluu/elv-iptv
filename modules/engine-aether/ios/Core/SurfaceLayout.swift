import Foundation

/// Clamped non-negative edge insets in view points for video surface framing (`#415`).
public struct SurfaceEdgeInsets: Equatable, Sendable {
  public static let zero = SurfaceEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

  public let top: Double
  public let left: Double
  public let bottom: Double
  public let right: Double

  public init(top: Double, left: Double, bottom: Double, right: Double) {
    self.top = (top.isFinite && top > 0) ? top : 0
    self.left = (left.isFinite && left > 0) ? left : 0
    self.bottom = (bottom.isFinite && bottom > 0) ? bottom : 0
    self.right = (right.isFinite && right > 0) ? right : 0
  }
}

/// Pure 2D surface frame rectangle in view points (`#415`).
public struct SurfaceRect: Equatable, Sendable {
  public static let zero = SurfaceRect(x: 0, y: 0, width: 0, height: 0)

  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

/// Video surface resize mode mirrored from `AetherSurface.resizeMode` (`#415`).
public enum SurfaceResizeMode: String, Equatable, Sendable {
  case fit
  case fill
  case stretch
}

/// Resolves the frame of `playerView` and `subtitleOverlayView` inside `AetherSurfaceView`.
/// Applies clamped safe-area insets only when `applySafeAreaOnFit && resizeMode == .fit` (iOS/iPadOS);
/// `fill`, `stretch`, and tvOS stay full-bleed across `bounds`.
public func resolveSurfaceVideoRect(
  boundsWidth: Double,
  boundsHeight: Double,
  safeAreaInsets: SurfaceEdgeInsets,
  resizeMode: SurfaceResizeMode,
  applySafeAreaOnFit: Bool
) -> SurfaceRect {
  let width = (boundsWidth.isFinite && boundsWidth > 0) ? boundsWidth : 0
  let height = (boundsHeight.isFinite && boundsHeight > 0) ? boundsHeight : 0
  guard width > 0, height > 0 else { return .zero }

  guard applySafeAreaOnFit, resizeMode == .fit else {
    return SurfaceRect(x: 0, y: 0, width: width, height: height)
  }

  let top = min(safeAreaInsets.top, height)
  let left = min(safeAreaInsets.left, width)
  let bottom = min(safeAreaInsets.bottom, max(0, height - top))
  let right = min(safeAreaInsets.right, max(0, width - left))
  return SurfaceRect(
    x: left,
    y: top,
    width: max(0, width - left - right),
    height: max(0, height - top - bottom)
  )
}

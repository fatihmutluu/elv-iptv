import Foundation

/// Video aspect-ratio scaling mode mirrored from `AetherSurface.resizeMode`.
public enum VideoScaleMode: Equatable, Sendable {
  case fit
  case fill
  case stretch
}

/// Pure 2D size in view points or coded pixels.
public struct LayoutSize: Equatable, Sendable {
  public static let zero = LayoutSize(width: 0, height: 0)

  public var width: Double
  public var height: Double

  public init(width: Double, height: Double) {
    self.width = width
    self.height = height
  }
}

/// Pure 2D rectangle in view points.
public struct LayoutRect: Equatable, Sendable {
  public static let zero = LayoutRect(x: 0, y: 0, width: 0, height: 0)

  public var x: Double
  public var y: Double
  public var width: Double
  public var height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  public var minX: Double { x }
  public var midX: Double { x + width * 0.5 }
  public var maxX: Double { x + width }
  public var minY: Double { y }
  public var midY: Double { y + height * 0.5 }
  public var maxY: Double { y + height }

  public func intersection(_ other: LayoutRect) -> LayoutRect {
    let left = max(minX, other.minX)
    let top = max(minY, other.minY)
    let right = min(maxX, other.maxX)
    let bottom = min(maxY, other.maxY)
    guard right > left, bottom > top else { return .zero }
    return LayoutRect(x: left, y: top, width: right - left, height: bottom - top)
  }
}

/// ASS `\an1`–`\an9` numpad subtitle alignment slots (`2` = bottom-center default).
public enum SubtitleSlot: Int, CaseIterable, Equatable, Hashable, Sendable {
  case bottomLeft = 1
  case bottomCenter = 2
  case bottomRight = 3
  case middleLeft = 4
  case middleCenter = 5
  case middleRight = 6
  case topLeft = 7
  case topCenter = 8
  case topRight = 9

  public enum HorizontalAlign: Equatable, Sendable {
    case left
    case center
    case right
  }

  public enum VerticalRow: Equatable, Sendable {
    case top
    case middle
    case bottom
  }

  public static func from(assAlignment: Int?) -> SubtitleSlot {
    guard let raw = assAlignment, let slot = SubtitleSlot(rawValue: raw) else {
      return .bottomCenter
    }
    return slot
  }

  public var horizontal: HorizontalAlign {
    switch self {
    case .bottomLeft, .middleLeft, .topLeft: return .left
    case .bottomCenter, .middleCenter, .topCenter: return .center
    case .bottomRight, .middleRight, .topRight: return .right
    }
  }

  public var vertical: VerticalRow {
    switch self {
    case .topLeft, .topCenter, .topRight: return .top
    case .middleLeft, .middleCenter, .middleRight: return .middle
    case .bottomLeft, .bottomCenter, .bottomRight: return .bottom
    }
  }
}

/// Pure subtitle stage, bitmap canvas, and 9-slot ASS pill geometry calculator.
public enum SubtitleLayout {
  public static func computeVideoRect(
    in bounds: LayoutRect,
    videoSize: LayoutSize,
    scaleMode: VideoScaleMode
  ) -> LayoutRect {
    guard bounds.width > 0, bounds.height > 0, bounds.width.isFinite, bounds.height.isFinite else {
      return .zero
    }
    guard videoSize.width > 0, videoSize.height > 0, videoSize.width.isFinite, videoSize.height.isFinite else {
      return bounds
    }
    let scale: Double
    switch scaleMode {
    case .stretch:
      return bounds
    case .fill:
      scale = max(bounds.width / videoSize.width, bounds.height / videoSize.height)
    case .fit:
      scale = min(bounds.width / videoSize.width, bounds.height / videoSize.height)
    }
    let width = videoSize.width * scale
    let height = videoSize.height * scale
    return LayoutRect(
      x: bounds.midX - width * 0.5,
      y: bounds.midY - height * 0.5,
      width: width,
      height: height
    )
  }

  /// Clamps text subtitle positioning to the visible intersection of `videoRect` and `bounds` so `resizeMode="fill"` never clips text.
  public static func visibleTextStage(videoRect: LayoutRect, bounds: LayoutRect) -> LayoutRect {
    videoRect.intersection(bounds)
  }

  /// Computes the bitmap composition canvas rect, preserving 1:1 picture bounds on anamorphic SD/HD DVB/DVD
  /// planes (`720x576`, `720x480`, `1440x1080`) while expanding 16:9 Blu-ray PGS canvases onto cropped wide rips.
  public static func computeCanvasRect(
    canvasSize: LayoutSize,
    videoSize: LayoutSize,
    videoRect: LayoutRect
  ) -> LayoutRect {
    guard canvasSize.width > 0, canvasSize.height > 0, videoRect.width > 0, videoRect.height > 0 else {
      return videoRect
    }
    guard videoSize.width > 0, videoSize.height > 0 else {
      let canvasHeight = videoRect.width * (canvasSize.height / canvasSize.width)
      return LayoutRect(
        x: videoRect.minX,
        y: videoRect.midY - canvasHeight * 0.5,
        width: videoRect.width,
        height: canvasHeight
      )
    }
    let canvasAspect = canvasSize.width / canvasSize.height
    let videoAspect = videoSize.width / videoSize.height
    // Expand taller than videoRect only for >= 16:9 composition canvases on wider cropped video (e.g. 1920x1080 PGS on 1920x800).
    if canvasAspect >= 1.7, videoAspect > canvasAspect * 1.05 {
      let canvasHeight = videoRect.height * (videoAspect / canvasAspect)
      return LayoutRect(
        x: videoRect.minX,
        y: videoRect.midY - canvasHeight * 0.5,
        width: videoRect.width,
        height: canvasHeight
      )
    }
    return videoRect
  }

  public static func baseFontSize(for visibleStage: LayoutRect) -> Double {
    guard visibleStage.height > 0 else { return 16 }
    let proportional = min(max(visibleStage.height * 0.044, 16), 52)
    return min(proportional, max(8, visibleStage.height * 0.45))
  }

  public static func pillPadding(for visibleStage: LayoutRect, fontSize: Double) -> (padX: Double, padY: Double) {
    let padX = min(max(6, fontSize * 0.45), max(0, visibleStage.width * 0.2))
    let padY = min(max(4, fontSize * 0.24), max(0, visibleStage.height * 0.2))
    return (padX, padY)
  }

  public static func measurementBox(
    slot: SubtitleSlot,
    visibleStage: LayoutRect,
    fontSize: Double
  ) -> LayoutSize {
    let (padX, _) = pillPadding(for: visibleStage, fontSize: fontSize)
    let maxPillW = maxAllowedPillWidth(slot: slot, visibleStage: visibleStage)
    let maxLabelW = max(1, maxPillW - padX * 2)
    let maxLabelH = max(1, visibleStage.height * 0.45)
    return LayoutSize(width: maxLabelW, height: maxLabelH)
  }

  public static func placeSlotPill(
    slot: SubtitleSlot,
    visibleStage: LayoutRect,
    measuredTextSize: LayoutSize,
    fontSize: Double,
    bottomInset: Double = 0
  ) -> (pillFrame: LayoutRect, labelFrame: LayoutRect) {
    guard visibleStage.width > 0, visibleStage.height > 0 else {
      return (.zero, .zero)
    }
    let (padX, padY) = pillPadding(for: visibleStage, fontSize: fontSize)
    let maxPillW = maxAllowedPillWidth(slot: slot, visibleStage: visibleStage)
    let pillWidth = max(0, min(maxPillW, min(visibleStage.width, ceil(max(0, measuredTextSize.width)) + padX * 2)))
    let pillHeight = max(0, min(visibleStage.height, ceil(max(0, measuredTextSize.height)) + padY * 2))

    let marginX = min(max(12, visibleStage.width * 0.04), max(0, (visibleStage.width - pillWidth) * 0.5))
    let rawX: Double
    switch slot.horizontal {
    case .left:
      rawX = visibleStage.minX + marginX
    case .center:
      rawX = visibleStage.midX - pillWidth * 0.5
    case .right:
      rawX = visibleStage.maxX - marginX - pillWidth
    }
    let clampedX = min(max(visibleStage.minX, rawX), max(visibleStage.minX, visibleStage.maxX - pillWidth))

    let safeBottomInset = (bottomInset.isFinite && bottomInset > 0) ? min(bottomInset, visibleStage.height * 0.45) : 0
    let marginY = min(max(12, visibleStage.height * 0.06), max(0, (visibleStage.height - pillHeight) * 0.5))
    let rawY: Double
    switch slot.vertical {
    case .top:
      rawY = visibleStage.minY + marginY
    case .middle:
      rawY = visibleStage.midY - pillHeight * 0.5
    case .bottom:
      rawY = visibleStage.maxY - marginY - safeBottomInset - pillHeight
    }
    let clampedY = min(max(visibleStage.minY, rawY), max(visibleStage.minY, visibleStage.maxY - pillHeight))

    let innerW = max(0, pillWidth - padX * 2)
    let innerH = max(0, pillHeight - padY * 2)
    let pillFrame = LayoutRect(x: clampedX, y: clampedY, width: pillWidth, height: pillHeight)
    let labelFrame = LayoutRect(
      x: (pillWidth - innerW) * 0.5,
      y: (pillHeight - innerH) * 0.5,
      width: innerW,
      height: innerH
    )
    return (pillFrame, labelFrame)
  }

  private static func maxAllowedPillWidth(slot: SubtitleSlot, visibleStage: LayoutRect) -> Double {
    switch slot.horizontal {
    case .center:
      return max(0, visibleStage.width * 0.92)
    case .left, .right:
      let margin = min(max(12, visibleStage.width * 0.04), visibleStage.width * 0.15)
      return max(0, visibleStage.width - margin * 2)
    }
  }
}

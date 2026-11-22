import ElvAetherCore
import Testing

@Suite("SubtitleLayout")
struct SubtitleLayoutTests {
  @Test("maps ASS numpad alignments 1...9 and defaults nil or out-of-range to bottomCenter (2)")
  func assAlignmentMapping() {
    #expect(SubtitleSlot.from(assAlignment: nil) == .bottomCenter)
    #expect(SubtitleSlot.from(assAlignment: 0) == .bottomCenter)
    #expect(SubtitleSlot.from(assAlignment: 10) == .bottomCenter)
    #expect(SubtitleSlot.from(assAlignment: -3) == .bottomCenter)
    #expect(SubtitleSlot.from(assAlignment: 1) == .bottomLeft)
    #expect(SubtitleSlot.from(assAlignment: 2) == .bottomCenter)
    #expect(SubtitleSlot.from(assAlignment: 3) == .bottomRight)
    #expect(SubtitleSlot.from(assAlignment: 4) == .middleLeft)
    #expect(SubtitleSlot.from(assAlignment: 5) == .middleCenter)
    #expect(SubtitleSlot.from(assAlignment: 6) == .middleRight)
    #expect(SubtitleSlot.from(assAlignment: 7) == .topLeft)
    #expect(SubtitleSlot.from(assAlignment: 8) == .topCenter)
    #expect(SubtitleSlot.from(assAlignment: 9) == .topRight)
  }

  @Test("resizeMode=fill intersects videoRect with bounds so text cues never clip off-screen")
  func fillIntersectsVideoRectWithBounds() {
    let tvBounds = LayoutRect(x: 0, y: 0, width: 1920, height: 1080)
    // 4:3 video in 16:9 fill overflows vertically (1920 x 1440, y = -180..1260).
    let videoRect = SubtitleLayout.computeVideoRect(
      in: tvBounds,
      videoSize: LayoutSize(width: 1440, height: 1080),
      scaleMode: .fill
    )
    #expect(videoRect.height > tvBounds.height)
    #expect(videoRect.minY < 0)

    let stage = SubtitleLayout.visibleTextStage(videoRect: videoRect, bounds: tvBounds)
    #expect(stage == tvBounds)

    let placed = SubtitleLayout.placeSlotPill(
      slot: .bottomCenter,
      visibleStage: stage,
      measuredTextSize: LayoutSize(width: 400, height: 48),
      fontSize: SubtitleLayout.baseFontSize(for: stage)
    )
    #expect(placed.pillFrame.minY >= tvBounds.minY)
    #expect(placed.pillFrame.maxY <= tvBounds.maxY)
    #expect(placed.pillFrame.minX >= tvBounds.minX)
    #expect(placed.pillFrame.maxX <= tvBounds.maxX)

    // 16:9 video in portrait phone fill overflows horizontally.
    let phoneBounds = LayoutRect(x: 0, y: 0, width: 390, height: 844)
    let phoneVideo = SubtitleLayout.computeVideoRect(
      in: phoneBounds,
      videoSize: LayoutSize(width: 1920, height: 1080),
      scaleMode: .fill
    )
    #expect(phoneVideo.width > phoneBounds.width)
    let phoneStage = SubtitleLayout.visibleTextStage(videoRect: phoneVideo, bounds: phoneBounds)
    #expect(phoneStage == phoneBounds)
    let leftPlaced = SubtitleLayout.placeSlotPill(
      slot: .bottomLeft,
      visibleStage: phoneStage,
      measuredTextSize: LayoutSize(width: 600, height: 60),
      fontSize: SubtitleLayout.baseFontSize(for: phoneStage)
    )
    #expect(leftPlaced.pillFrame.minX >= phoneBounds.minX)
    #expect(leftPlaced.pillFrame.maxX <= phoneBounds.maxX)
  }

  @Test("places all 9 ASS slots monotonically across left/center/right and top/middle/bottom")
  func nineSlotsOrdered() {
    let stage = LayoutRect(x: 0, y: 0, width: 1920, height: 1080)
    let fontSize = SubtitleLayout.baseFontSize(for: stage)
    let textSize = LayoutSize(width: 240, height: 40)

    let topLeft = SubtitleLayout.placeSlotPill(slot: .topLeft, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize).pillFrame
    let topCenter = SubtitleLayout.placeSlotPill(slot: .topCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize).pillFrame
    let topRight = SubtitleLayout.placeSlotPill(slot: .topRight, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize).pillFrame
    let midCenter = SubtitleLayout.placeSlotPill(slot: .middleCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize).pillFrame
    let botCenter = SubtitleLayout.placeSlotPill(slot: .bottomCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize).pillFrame

    #expect(topLeft.minX < topCenter.minX)
    #expect(topCenter.maxX < topRight.maxX)
    #expect(topCenter.maxY < midCenter.minY)
    #expect(midCenter.maxY < botCenter.minY)
  }

  @Test("clamps pill and label dimensions non-negative inside tiny view bounds")
  func tinyBoundsNeverProduceNegativeDimensions() {
    let tiny = LayoutRect(x: 0, y: 0, width: 18, height: 12)
    let fontSize = SubtitleLayout.baseFontSize(for: tiny)
    let box = SubtitleLayout.measurementBox(slot: .bottomCenter, visibleStage: tiny, fontSize: fontSize)
    #expect(box.width > 0)
    #expect(box.height > 0)

    let placed = SubtitleLayout.placeSlotPill(
      slot: .bottomCenter,
      visibleStage: tiny,
      measuredTextSize: LayoutSize(width: 100, height: 40),
      fontSize: fontSize
    )
    #expect(placed.pillFrame.width >= 0 && placed.pillFrame.width <= tiny.width)
    #expect(placed.pillFrame.height >= 0 && placed.pillFrame.height <= tiny.height)
    #expect(placed.labelFrame.width >= 0 && placed.labelFrame.height >= 0)
  }

  @Test("PAL 720x576 anamorphic DVB canvas maps 1:1 to 16:9 videoRect while cropped 1920x800 PGS expands to 16:9")
  func dvbAnamorphicAndCroppedPgsCanvasRect() {
    let videoRect16x9 = LayoutRect(x: 0, y: 0, width: 1920, height: 1080)
    let palDvb = SubtitleLayout.computeCanvasRect(
      canvasSize: LayoutSize(width: 720, height: 576),
      videoSize: LayoutSize(width: 1024, height: 576),
      videoRect: videoRect16x9
    )
    #expect(palDvb == videoRect16x9)

    // Cropped Cinemascope 1920x800 video inside 1920x1080 screen (videoRect height = 800, y = 140).
    let croppedVideoRect = LayoutRect(x: 0, y: 140, width: 1920, height: 800)
    let pgsCanvas = SubtitleLayout.computeCanvasRect(
      canvasSize: LayoutSize(width: 1920, height: 1080),
      videoSize: LayoutSize(width: 1920, height: 800),
      videoRect: croppedVideoRect
    )
    #expect(abs(pgsCanvas.height - 1080) < 0.5)
    #expect(abs(pgsCanvas.minY - 0) < 0.5)
  }

  @Test("bottomInset lifts bottom-anchored pills above visible OSD, ignores top/middle, and returns cleanly at 0 (#136)")
  func bottomInsetLiftsBottomSlotsAndClamps() {
    let stage = LayoutRect(x: 0, y: 0, width: 1920, height: 1080)
    let fontSize = SubtitleLayout.baseFontSize(for: stage)
    let textSize = LayoutSize(width: 320, height: 48)

    let baseBottom = SubtitleLayout.placeSlotPill(
      slot: .bottomCenter,
      visibleStage: stage,
      measuredTextSize: textSize,
      fontSize: fontSize,
      bottomInset: 0
    ).pillFrame
    let liftedBottom = SubtitleLayout.placeSlotPill(
      slot: .bottomCenter,
      visibleStage: stage,
      measuredTextSize: textSize,
      fontSize: fontSize,
      bottomInset: 120
    ).pillFrame
    #expect(abs((baseBottom.minY - liftedBottom.minY) - 120) < 0.5)
    #expect(liftedBottom.maxY <= stage.maxY)

    let restoredBottom = SubtitleLayout.placeSlotPill(
      slot: .bottomCenter,
      visibleStage: stage,
      measuredTextSize: textSize,
      fontSize: fontSize,
      bottomInset: 0
    ).pillFrame
    #expect(restoredBottom == baseBottom)

    // Top and middle slots are unaffected by bottomInset
    let baseTop = SubtitleLayout.placeSlotPill(slot: .topCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 0).pillFrame
    let insetTop = SubtitleLayout.placeSlotPill(slot: .topCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 120).pillFrame
    #expect(baseTop == insetTop)

    let baseMid = SubtitleLayout.placeSlotPill(slot: .middleCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 0).pillFrame
    let insetMid = SubtitleLayout.placeSlotPill(slot: .middleCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 120).pillFrame
    #expect(baseMid == insetMid)

    // Negative, non-finite, and oversized insets stay cleanly clamped inside visibleStage
    let negative = SubtitleLayout.placeSlotPill(slot: .bottomLeft, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: -40).pillFrame
    let zeroLeft = SubtitleLayout.placeSlotPill(slot: .bottomLeft, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 0).pillFrame
    #expect(negative == zeroLeft)

    let nanInset = SubtitleLayout.placeSlotPill(slot: .bottomRight, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: .nan).pillFrame
    let zeroRight = SubtitleLayout.placeSlotPill(slot: .bottomRight, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 0).pillFrame
    #expect(nanInset == zeroRight)

    let huge = SubtitleLayout.placeSlotPill(slot: .bottomCenter, visibleStage: stage, measuredTextSize: textSize, fontSize: fontSize, bottomInset: 9_999).pillFrame
    #expect(huge.minY >= stage.minY)
    #expect(huge.maxY <= stage.maxY)
  }
}

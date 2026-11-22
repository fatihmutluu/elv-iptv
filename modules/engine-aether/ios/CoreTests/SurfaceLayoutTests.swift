import ElvAetherCore
import Foundation
import Testing

@Suite("SurfaceLayout (#415)")
struct SurfaceLayoutTests {
  @Test("insets video rect by safe area only when applySafeAreaOnFit is true and resizeMode is fit")
  func insetsOnlyOnIosFitMode() {
    let landscapeInsets = SurfaceEdgeInsets(top: 0, left: 59, bottom: 21, right: 59)

    let fitIos = resolveSurfaceVideoRect(
      boundsWidth: 852,
      boundsHeight: 393,
      safeAreaInsets: landscapeInsets,
      resizeMode: .fit,
      applySafeAreaOnFit: true
    )
    #expect(fitIos == SurfaceRect(x: 59, y: 0, width: 734, height: 372))

    let fillIos = resolveSurfaceVideoRect(
      boundsWidth: 852,
      boundsHeight: 393,
      safeAreaInsets: landscapeInsets,
      resizeMode: .fill,
      applySafeAreaOnFit: true
    )
    #expect(fillIos == SurfaceRect(x: 0, y: 0, width: 852, height: 393))

    let stretchIos = resolveSurfaceVideoRect(
      boundsWidth: 852,
      boundsHeight: 393,
      safeAreaInsets: landscapeInsets,
      resizeMode: .stretch,
      applySafeAreaOnFit: true
    )
    #expect(stretchIos == SurfaceRect(x: 0, y: 0, width: 852, height: 393))

    let fitTvos = resolveSurfaceVideoRect(
      boundsWidth: 1920,
      boundsHeight: 1080,
      safeAreaInsets: SurfaceEdgeInsets(top: 60, left: 80, bottom: 60, right: 80),
      resizeMode: .fit,
      applySafeAreaOnFit: false
    )
    #expect(fitTvos == SurfaceRect(x: 0, y: 0, width: 1920, height: 1080))
  }

  @Test("clamps negative, non-finite, and oversized insets so resulting frame never has negative dimensions")
  func clampsInvalidAndOversizedInsets() {
    let dirtyInsets = SurfaceEdgeInsets(top: -10, left: .nan, bottom: .infinity, right: 20)
    #expect(dirtyInsets == SurfaceEdgeInsets(top: 0, left: 0, bottom: 0, right: 20))

    let portrait = resolveSurfaceVideoRect(
      boundsWidth: 393,
      boundsHeight: 852,
      safeAreaInsets: SurfaceEdgeInsets(top: 59, left: 0, bottom: 34, right: 0),
      resizeMode: .fit,
      applySafeAreaOnFit: true
    )
    #expect(portrait == SurfaceRect(x: 0, y: 59, width: 393, height: 759))

    let oversized = resolveSurfaceVideoRect(
      boundsWidth: 100,
      boundsHeight: 80,
      safeAreaInsets: SurfaceEdgeInsets(top: 60, left: 70, bottom: 60, right: 70),
      resizeMode: .fit,
      applySafeAreaOnFit: true
    )
    #expect(oversized.width == 0)
    #expect(oversized.height == 0)
    #expect(oversized.x == 70)
    #expect(oversized.y == 60)

    #expect(
      resolveSurfaceVideoRect(
        boundsWidth: 0,
        boundsHeight: 393,
        safeAreaInsets: .zero,
        resizeMode: .fit,
        applySafeAreaOnFit: true
      ) == .zero
    )
    #expect(
      resolveSurfaceVideoRect(
        boundsWidth: .nan,
        boundsHeight: 393,
        safeAreaInsets: .zero,
        resizeMode: .fit,
        applySafeAreaOnFit: true
      ) == .zero
    )
  }
}

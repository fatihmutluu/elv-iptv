import ElvAetherCore
import Foundation
import Testing

@Suite("OsdClockThrottle (#442)")
struct OsdClockThrottleTests {
  @Test("always emits while OSD is visible and reports false-to-true transitions")
  func visibleModeAndVisibilityTransitions() {
    var throttle = OsdClockThrottle(hiddenIntervalSeconds: 5.0, osdVisible: true)
    #expect(throttle.osdVisible)
    let noopShow = throttle.setOsdVisible(true)
    #expect(!noopShow)
    let t1 = throttle.shouldEmit(nowSeconds: 10.0, rate: 1.0, isPlaying: true)
    let t2 = throttle.shouldEmit(nowSeconds: 10.1, rate: 1.0, isPlaying: true)
    let t3 = throttle.shouldEmit(nowSeconds: 10.2, rate: 1.0, isPlaying: true)
    #expect(t1)
    #expect(t2)
    #expect(t3)

    let hide1 = throttle.setOsdVisible(false)
    #expect(!hide1)
    #expect(!throttle.osdVisible)
    let hide2 = throttle.setOsdVisible(false)
    #expect(!hide2)

    let showAgain = throttle.setOsdVisible(true)
    #expect(showAgain)
    #expect(throttle.osdVisible)
  }

  @Test("hidden OSD throttles steady ticks to hiddenIntervalSeconds while passing first tick and rate/play transitions")
  func hiddenModeThrottlingAndImmediateEdgePasses() {
    var throttle = OsdClockThrottle(hiddenIntervalSeconds: 5.0, osdVisible: false)

    // First tick always emits.
    let first = throttle.shouldEmit(nowSeconds: 100.0, rate: 1.0, isPlaying: true)
    #expect(first)

    // Subsequent steady ticks within 5.0 s are suppressed.
    let suppressed1 = throttle.shouldEmit(nowSeconds: 101.0, rate: 1.0, isPlaying: true)
    let suppressed2 = throttle.shouldEmit(nowSeconds: 104.99, rate: 1.0, isPlaying: true)
    #expect(!suppressed1)
    #expect(!suppressed2)

    // Tick at >= 5.0 s emits and advances baseline.
    let boundary = throttle.shouldEmit(nowSeconds: 105.0, rate: 1.0, isPlaying: true)
    let afterBoundary = throttle.shouldEmit(nowSeconds: 108.0, rate: 1.0, isPlaying: true)
    #expect(boundary)
    #expect(!afterBoundary)

    // Rate change passes immediately.
    let rateEdge = throttle.shouldEmit(nowSeconds: 108.2, rate: 1.5, isPlaying: true)
    let afterRateEdge = throttle.shouldEmit(nowSeconds: 110.0, rate: 1.5, isPlaying: true)
    #expect(rateEdge)
    #expect(!afterRateEdge)

    // Playing-state change passes immediately.
    let playEdge = throttle.shouldEmit(nowSeconds: 110.5, rate: 0.0, isPlaying: false)
    let afterPlayEdge = throttle.shouldEmit(nowSeconds: 112.0, rate: 0.0, isPlaying: false)
    #expect(playEdge)
    #expect(!afterPlayEdge)

    // Reset clears prior tick history without clobbering osdVisible == false.
    throttle.reset()
    #expect(!throttle.osdVisible)
    let afterReset = throttle.shouldEmit(nowSeconds: 112.5, rate: 0.0, isPlaying: false)
    #expect(afterReset)
  }
}

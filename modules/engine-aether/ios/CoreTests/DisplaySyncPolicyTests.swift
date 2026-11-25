import ElvAetherCore
import Foundation
import Testing

@Suite("DisplaySyncPolicy (#188, #116)")
struct DisplaySyncPolicyTests {
  @Test("parses auto frame rate mode strings safely with seamless fallback")
  func parsesAutoFrameRateModes() {
    #expect(AppleAutoFrameRateMode.parse("off") == .off)
    #expect(AppleAutoFrameRateMode.parse("SEAMLESS") == .seamless)
    #expect(AppleAutoFrameRateMode.parse("  always  ") == .always)
    #expect(AppleAutoFrameRateMode.parse(nil) == .seamless)
    #expect(AppleAutoFrameRateMode.parse("") == .seamless)
    #expect(AppleAutoFrameRateMode.parse("unknown") == .seamless)
  }

  @Test("parses HDR dynamic range tags including StreamVideoInfo dv shorthand")
  func parsesHdrDynamicRangeTags() {
    #expect(AppleHdrDynamicRange.parse("sdr") == .sdr)
    #expect(AppleHdrDynamicRange.parse("HDR10") == .hdr10)
    #expect(AppleHdrDynamicRange.parse("hlg") == .hlg)
    #expect(AppleHdrDynamicRange.parse("dv") == .dolbyVision)
    #expect(AppleHdrDynamicRange.parse("dolbyVision") == .dolbyVision)
    #expect(AppleHdrDynamicRange.parse("dolby-vision") == .dolbyVision)
    #expect(AppleHdrDynamicRange.parse(nil) == nil)
    #expect(AppleHdrDynamicRange.parse("   ") == nil)
    #expect(AppleHdrDynamicRange.parse("unknown") == nil)
  }

  @Test("snaps standard cinema and broadcast frame rates within 0.15 fps and rejects out-of-range values")
  func snapsStandardFrameRates() {
    #expect(snapAppleStandardFrameRate(23.976) == Float(23.976))
    #expect(snapAppleStandardFrameRate(23.98) == Float(23.976))
    #expect(snapAppleStandardFrameRate(24.0) == Float(24.0))
    #expect(snapAppleStandardFrameRate(24.05) == Float(24.0))
    #expect(snapAppleStandardFrameRate(25.0) == Float(25.0))
    #expect(snapAppleStandardFrameRate(25.12) == Float(25.0))
    #expect(snapAppleStandardFrameRate(29.97) == Float(29.97))
    #expect(snapAppleStandardFrameRate(29.975) == Float(29.97))
    #expect(snapAppleStandardFrameRate(30.0) == Float(30.0))
    #expect(snapAppleStandardFrameRate(50.0) == Float(50.0))
    #expect(snapAppleStandardFrameRate(59.94) == Float(59.94))
    #expect(snapAppleStandardFrameRate(59.95) == Float(59.94))
    #expect(snapAppleStandardFrameRate(60.0) == Float(60.0))
    #expect(snapAppleStandardFrameRate(60.14) == Float(60.0))

    // Rejects outside +/-0.15 tolerance, non-finite, non-positive, and excessive rates
    #expect(snapAppleStandardFrameRate(24.25) == nil)
    #expect(snapAppleStandardFrameRate(48.0) == nil)
    #expect(snapAppleStandardFrameRate(0.0) == nil)
    #expect(snapAppleStandardFrameRate(-24.0) == nil)
    #expect(snapAppleStandardFrameRate(.nan) == nil)
    #expect(snapAppleStandardFrameRate(.infinity) == nil)
    #expect(snapAppleStandardFrameRate(241.0) == nil)
  }

  @Test("planAppleDisplayCriteria disables switching on non-tvOS or when both AFR and HDR are off")
  func disablesWhenNonTvOsOrBothOff() {
    let iosPlan = planAppleDisplayCriteria(
      settings: .default,
      fps: 23.976,
      hdr: .dolbyVision,
      isTvOS: false
    )
    #expect(
      iosPlan == AppleDisplayCriteriaPlan(
        shouldApply: false,
        refreshRate: nil,
        dynamicRange: nil,
        shutterSettleMs: 0
      )
    )

    let disabledPlan = planAppleDisplayCriteria(
      settings: .disabled,
      fps: 23.976,
      hdr: .hdr10,
      isTvOS: true
    )
    #expect(
      disabledPlan == AppleDisplayCriteriaPlan(
        shouldApply: false,
        refreshRate: nil,
        dynamicRange: nil,
        shutterSettleMs: 0
      )
    )
  }

  @Test("planAppleDisplayCriteria selectively applies AFR and HDR and sets 650 ms shutter settle only on changes")
  func plansDisplayCriteriaAndShutterSettleWindow() {
    // Initial 23.976 fps HDR10 stream on tvOS applies both and arms 650 ms HDMI shutter settle
    let initialPlan = planAppleDisplayCriteria(
      settings: AppleDisplaySyncSettings(autoFrameRate: .seamless, autoDynamicRange: true),
      fps: 23.98,
      hdr: .hdr10,
      isTvOS: true
    )
    #expect(
      initialPlan == AppleDisplayCriteriaPlan(
        shouldApply: true,
        refreshRate: Float(23.976),
        dynamicRange: .hdr10,
        shutterSettleMs: 650
      )
    )

    // Identical rate and dynamic range produces 0 ms shutter settle (no black flash on same-cadence zap)
    let unchangedPlan = planAppleDisplayCriteria(
      settings: AppleDisplaySyncSettings(autoFrameRate: .seamless, autoDynamicRange: true),
      fps: 23.976,
      hdr: .hdr10,
      isTvOS: true,
      previousRefreshRate: Float(23.976),
      previousDynamicRange: .hdr10
    )
    #expect(
      unchangedPlan == AppleDisplayCriteriaPlan(
        shouldApply: true,
        refreshRate: Float(23.976),
        dynamicRange: .hdr10,
        shutterSettleMs: 0
      )
    )

    // Changing refresh rate or HDR triggers 650 ms shutter settle
    let rateChangedPlan = planAppleDisplayCriteria(
      settings: AppleDisplaySyncSettings(autoFrameRate: .always, autoDynamicRange: true),
      fps: 50.0,
      hdr: .hdr10,
      isTvOS: true,
      previousRefreshRate: Float(23.976),
      previousDynamicRange: .hdr10
    )
    #expect(rateChangedPlan.shouldApply)
    #expect(rateChangedPlan.refreshRate == Float(50.0))
    #expect(rateChangedPlan.dynamicRange == .hdr10)
    #expect(rateChangedPlan.shutterSettleMs == 650)

    // AFR only (autoDynamicRange = false) omits dynamicRange
    let afrOnlyPlan = planAppleDisplayCriteria(
      settings: AppleDisplaySyncSettings(autoFrameRate: .always, autoDynamicRange: false),
      fps: 59.94,
      hdr: .dolbyVision,
      isTvOS: true
    )
    #expect(
      afrOnlyPlan == AppleDisplayCriteriaPlan(
        shouldApply: true,
        refreshRate: Float(59.94),
        dynamicRange: nil,
        shutterSettleMs: 650
      )
    )

    // HDR only (autoFrameRate = .off) omits refreshRate
    let hdrOnlyPlan = planAppleDisplayCriteria(
      settings: AppleDisplaySyncSettings(autoFrameRate: .off, autoDynamicRange: true),
      fps: 23.976,
      hdr: .hlg,
      isTvOS: true
    )
    #expect(
      hdrOnlyPlan == AppleDisplayCriteriaPlan(
        shouldApply: true,
        refreshRate: nil,
        dynamicRange: .hlg,
        shutterSettleMs: 650
      )
    )

    // Missing both usable FPS and HDR yields shouldApply = false
    let emptyPlan = planAppleDisplayCriteria(
      settings: .default,
      fps: 48.0,
      hdr: nil,
      isTvOS: true
    )
    #expect(
      emptyPlan == AppleDisplayCriteriaPlan(
        shouldApply: false,
        refreshRate: nil,
        dynamicRange: nil,
        shutterSettleMs: 0
      )
    )
  }

  @Test("shouldResetDisplayCriteria avoids HDMI flicker during live zaps/rebuilds and resets on stop, dispose, or disable")
  func evaluatesDisplayCriteriaResetPolicy() {
    let enabled = AppleDisplaySyncSettings(autoFrameRate: .seamless, autoDynamicRange: true)
    let afrOnly = AppleDisplaySyncSettings(autoFrameRate: .always, autoDynamicRange: false)
    let hdrOnly = AppleDisplaySyncSettings(autoFrameRate: .off, autoDynamicRange: true)
    let disabled = AppleDisplaySyncSettings(autoFrameRate: .off, autoDynamicRange: false)

    #expect(!shouldResetDisplayCriteria(reason: .zap, settings: enabled))
    #expect(!shouldResetDisplayCriteria(reason: .rebuild, settings: enabled))
    #expect(shouldResetDisplayCriteria(reason: .userStop, settings: enabled))
    #expect(shouldResetDisplayCriteria(reason: .dispose, settings: enabled))

    #expect(!shouldResetDisplayCriteria(reason: .zap, settings: afrOnly))
    #expect(!shouldResetDisplayCriteria(reason: .rebuild, settings: hdrOnly))

    // When both AFR and HDR are disabled, always reset criteria cleanly
    #expect(shouldResetDisplayCriteria(reason: .zap, settings: disabled))
    #expect(shouldResetDisplayCriteria(reason: .rebuild, settings: disabled))
    #expect(shouldResetDisplayCriteria(reason: .userStop, settings: disabled))
    #expect(shouldResetDisplayCriteria(reason: .dispose, settings: disabled))
  }

  @Test("resolveDisplayCriteriaOwner disables engine ownership only when both AFR and HDR are off")
  func resolvesDisplayCriteriaOwner() {
    #expect(resolveDisplayCriteriaOwner(for: .default) == .engine)
    #expect(resolveDisplayCriteriaOwner(for: AppleDisplaySyncSettings(autoFrameRate: .always, autoDynamicRange: false)) == .engine)
    #expect(resolveDisplayCriteriaOwner(for: AppleDisplaySyncSettings(autoFrameRate: .off, autoDynamicRange: true)) == .engine)
    #expect(resolveDisplayCriteriaOwner(for: .disabled) == .host)
  }
}

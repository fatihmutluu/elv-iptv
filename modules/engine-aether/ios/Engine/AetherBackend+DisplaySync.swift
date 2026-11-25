import AetherEngine
import AVFoundation
import CoreMedia
import Foundation
#if os(tvOS)
import AVKit
import UIKit
#endif

extension AetherBackend {
  private static var isTvOSPlatform: Bool {
    #if os(tvOS)
    return true
    #else
    return false
    #endif
  }

  /// Updates live AFR/HDR display-sync settings, resetting criteria immediately when disabled or re-evaluating when active (`#188`, `#116`).
  func setDisplaySync(_ settings: AppleDisplaySyncSettings) {
    displaySyncSettings = settings
    if var opts = currentLoadOptions {
      opts.displaySync = settings
      opts.displayCriteriaOwner = resolveDisplayCriteriaOwner(for: settings)
      currentLoadOptions = opts
    }
    if !settings.isEnabled {
      resetDisplayCriteria()
      return
    }
    if activeLoadSerial > 0 {
      applyDisplayCriteriaIfReady()
    }
  }

  /// Clears per-stream observed video cadence/HDR metadata without clearing active HDMI criteria across zaps.
  func resetObservedDisplayVideoMetadata() {
    lastObservedVideoFps = nil
    lastObservedVideoHdr = nil
    #if os(tvOS)
    lastObservedFormatDescription = nil
    #endif
  }

  /// Records stabilized video cadence/HDR metadata from `inspectAndEmitVideoInfo` and applies tvOS display criteria if enabled.
  func handleStabilizedVideoMetadata(
    fps: Double?,
    hdr: String?,
    formatDescription: CMFormatDescription?
  ) {
    lastObservedVideoFps = fps
    lastObservedVideoHdr = AppleHdrDynamicRange.parse(hdr)
    #if os(tvOS)
    lastObservedFormatDescription = formatDescription
    #else
    _ = formatDescription
    #endif
    applyDisplayCriteriaIfReady()
  }

  /// Evaluates `planAppleDisplayCriteria` and drives tvOS `AVDisplayManager.preferredDisplayCriteria` guarded by HDMI shutter settle.
  func applyDisplayCriteriaIfReady() {
    let plan = planAppleDisplayCriteria(
      settings: displaySyncSettings,
      fps: lastObservedVideoFps,
      hdr: lastObservedVideoHdr,
      isTvOS: Self.isTvOSPlatform,
      previousRefreshRate: appliedDisplayRefreshRate,
      previousDynamicRange: appliedDisplayDynamicRange
    )
    guard plan.shouldApply else { return }

    #if os(tvOS)
    guard let displayManager = activeDisplayManager(),
          displayManager.isDisplayCriteriaMatchingEnabled,
          let criteria = Self.makeDisplayCriteria(
            plan: plan,
            sourceFormatDescription: lastObservedFormatDescription
          )
    else {
      return
    }
    appliedDisplayRefreshRate = plan.refreshRate
    appliedDisplayDynamicRange = plan.dynamicRange
    if plan.shutterSettleMs > 0 {
      onHdmiShutterSettle?(plan.shutterSettleMs)
    }
    displayManager.preferredDisplayCriteria = criteria
    #endif
  }

  /// Resets tvOS `AVDisplayManager.preferredDisplayCriteria` and clears cached applied criteria state.
  func resetDisplayCriteria() {
    appliedDisplayRefreshRate = nil
    appliedDisplayDynamicRange = nil
    #if os(tvOS)
    activeDisplayManager()?.preferredDisplayCriteria = nil
    #endif
  }

  /// Applies user-stop display criteria reset policy (preserving `resetDisplayCriteria: false` on live zaps).
  func stopDisplayCriteriaForUserStop() {
    guard shouldResetDisplayCriteria(reason: .userStop, settings: displaySyncSettings) else { return }
    engine?.stop(resetDisplayCriteria: true, finalTeardown: false)
    resetDisplayCriteria()
  }

  #if os(tvOS)
  private func activeDisplayManager() -> AVDisplayManager? {
    if let window = boundPlayerView?.window {
      return window.avDisplayManager
    }
    for scene in UIApplication.shared.connectedScenes {
      guard let windowScene = scene as? UIWindowScene else { continue }
      if let keyWindow = windowScene.windows.first(where: \.isKeyWindow) ?? windowScene.windows.first {
        return keyWindow.avDisplayManager
      }
    }
    return nil
  }

  private static func makeDisplayCriteria(
    plan: AppleDisplayCriteriaPlan,
    sourceFormatDescription: CMFormatDescription?
  ) -> AVDisplayCriteria? {
    let refreshRate: Float = plan.refreshRate ?? 0
    let formatDescription: CMFormatDescription?
    if plan.dynamicRange != nil, let sourceFormatDescription {
      formatDescription = sourceFormatDescription
    } else {
      formatDescription = makeSyntheticFormatDescription(for: plan.dynamicRange ?? .sdr)
    }
    guard let formatDescription else { return nil }
    return AVDisplayCriteria(refreshRate: refreshRate, formatDescription: formatDescription)
  }

  private static func makeSyntheticFormatDescription(
    for dynamicRange: AppleHdrDynamicRange
  ) -> CMFormatDescription? {
    let codecType: CMVideoCodecType
    var extensions: [CFString: Any] = [:]
    switch dynamicRange {
    case .sdr:
      codecType = kCMVideoCodecType_H264
    case .hdr10:
      codecType = kCMVideoCodecType_HEVC
      extensions[kCMFormatDescriptionExtension_TransferFunction] =
        kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ
      extensions[kCMFormatDescriptionExtension_ColorPrimaries] =
        kCMFormatDescriptionColorPrimaries_ITU_R_2020
      extensions[kCMFormatDescriptionExtension_YCbCrMatrix] =
        kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    case .hlg:
      codecType = kCMVideoCodecType_HEVC
      extensions[kCMFormatDescriptionExtension_TransferFunction] =
        kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG
      extensions[kCMFormatDescriptionExtension_ColorPrimaries] =
        kCMFormatDescriptionColorPrimaries_ITU_R_2020
      extensions[kCMFormatDescriptionExtension_YCbCrMatrix] =
        kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    case .dolbyVision:
      codecType = 0x6476_6831 // 'dvh1'
      extensions[kCMFormatDescriptionExtension_TransferFunction] =
        kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ
      extensions[kCMFormatDescriptionExtension_ColorPrimaries] =
        kCMFormatDescriptionColorPrimaries_ITU_R_2020
      extensions[kCMFormatDescriptionExtension_YCbCrMatrix] =
        kCMFormatDescriptionYCbCrMatrix_ITU_R_2020
    }
    let cfExtensions: CFDictionary? = extensions.isEmpty ? nil : (extensions as CFDictionary)
    var out: CMVideoFormatDescription?
    let status = CMVideoFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      codecType: codecType,
      width: 1920,
      height: 1080,
      extensions: cfExtensions,
      formatDescriptionOut: &out
    )
    guard status == noErr else { return nil }
    return out
  }
  #endif
}

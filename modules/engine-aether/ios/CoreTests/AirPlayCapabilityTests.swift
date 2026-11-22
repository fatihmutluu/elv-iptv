import ElvAetherCore
import Foundation
import Testing

@Suite("AirPlayCapability (#234)")
struct AirPlayCapabilityTests {
  @Test("parseAirPlayTxtModel extracts trimmed model case-insensitively")
  func parseTxtModelIsCaseInsensitiveAndTrimmed() {
    #expect(parseAirPlayTxtModel(["model": "AppleTV14,1"]) == "AppleTV14,1")
    #expect(parseAirPlayTxtModel(["MODEL": "  AudioAccessory5,1 \n"]) == "AudioAccessory5,1")
    #expect(parseAirPlayTxtModel(["Model": "GenericSmartTV"]) == "GenericSmartTV")
    #expect(parseAirPlayTxtModel(["model": "   "]) == nil)
    #expect(parseAirPlayTxtModel(["features": "0x5A7FFFF7"]) == nil)
    #expect(parseAirPlayTxtModel([:]) == nil)
  }

  @Test("classifyAirPlayReceiver distinguishes Apple surround receivers from third-party stereo and unknown")
  func classifyReceiverModels() {
    let appleModels = [
      "AppleTV14,1",
      "AppleTV6,2",
      "AudioAccessory5,1",
      "Mac14,2",
      "iMac21,1",
      "MacBookPro18,1",
      "Macmini9,1",
      "MacPro7,1",
      "MacStudio14,13",
      "iPad14,1",
      "iPhone16,1",
    ]
    for model in appleModels {
      #expect(classifyAirPlayReceiver(model: model) == .appleSurround)
    }

    let thirdPartyModels = ["WebOSTV", "SmartTV_2025", "Soundbar_Pro", "ReceiverAVR"]
    for model in thirdPartyModels {
      #expect(classifyAirPlayReceiver(model: model) == .thirdPartyStereo)
    }

    #expect(classifyAirPlayReceiver(model: nil) == .unknown)
    #expect(classifyAirPlayReceiver(model: "") == .unknown)
    #expect(classifyAirPlayReceiver(model: "   ") == .unknown)
  }

  @Test("AirPlayCapabilityTracker computes audio mode and normalizes route vs Bonjour service names")
  func trackerCorrelatesRoutesAndBonjourRecords() {
    var tracker = AirPlayCapabilityTracker()
    #expect(!tracker.isAirPlayActive)
    #expect(!tracker.shouldBrowseBonjour)
    #expect(tracker.recommendedAudioMode == .surroundPassthrough)

    // Active AirPlay route defaults conservatively to stereo AAC-LC until Bonjour TXT confirms Apple hardware.
    tracker.updateRoute(airPlayPortName: "  Salon\u{2019}s   Apple TV  ")
    #expect(tracker.isAirPlayActive)
    #expect(tracker.shouldBrowseBonjour)
    #expect(tracker.activeReceiverClass == .unknown)
    #expect(tracker.recommendedAudioMode == .stereoAacLc)

    // Diacritic, apostrophe, whitespace, and case differences still match the active AirPlay route.
    tracker.recordDiscoveredService(name: "salón's apple tv", txtRecord: ["MODEL": "AppleTV14,1"])
    #expect(tracker.activeReceiverClass == .appleSurround)
    #expect(tracker.recommendedAudioMode == .surroundPassthrough)

    // Switching to a third-party receiver downgrades audio to stereo AAC-LC.
    tracker.recordDiscoveredService(name: "Bedroom Display", txtRecord: ["model": "GenericTV_4K"])
    tracker.updateRoute(airPlayPortName: "Bedroom Display")
    #expect(tracker.activeReceiverClass == .thirdPartyStereo)
    #expect(tracker.recommendedAudioMode == .stereoAacLc)

    // Removing the Bonjour record reverts classification to unknown (still stereo AAC-LC).
    tracker.removeDiscoveredService(name: "Bedroom Display")
    #expect(tracker.activeReceiverClass == .unknown)
    #expect(tracker.recommendedAudioMode == .stereoAacLc)

    // External playback without a matched port name stays stereo AAC-LC even when Apple devices exist on LAN.
    tracker.updateRoute(airPlayPortName: nil)
    tracker.updateExternalPlayback(active: true)
    #expect(tracker.shouldBrowseBonjour)
    #expect(tracker.activeReceiverClass == .unknown)
    #expect(tracker.recommendedAudioMode == .stereoAacLc)

    // Returning to local playback stops browsing and restores surround passthrough.
    tracker.updateExternalPlayback(active: false)
    #expect(!tracker.isAirPlayActive)
    #expect(!tracker.shouldBrowseBonjour)
    #expect(tracker.recommendedAudioMode == .surroundPassthrough)

    // replaceDiscoveredServices replaces snapshot atomically and reset clears all state.
    tracker.updateRoute(airPlayPortName: "Living Room")
    tracker.replaceDiscoveredServices([(name: "Living Room", model: "AudioAccessory6,1")])
    #expect(tracker.recommendedAudioMode == .surroundPassthrough)
    tracker.replaceDiscoveredServices([])
    #expect(tracker.recommendedAudioMode == .stereoAacLc)
    tracker.reset()
    #expect(!tracker.isAirPlayActive)
    #expect(tracker.activeAirPlayPortName == nil)
    #expect(tracker.recommendedAudioMode == .surroundPassthrough)
  }
}

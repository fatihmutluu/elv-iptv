import AetherEngine
import Foundation

/// Translates engine-neutral `EngineLoadOptions` from `Core` onto `AetherEngine.LoadOptions`.
func aetherOptions(_ options: EngineLoadOptions) -> LoadOptions {
  var out = LoadOptions()
  out.isLive = options.isLive
  out.httpHeaders = options.httpHeaders
  out.maxConcurrentSourceRequests = options.maxConcurrentSourceRequests
  if options.preferSoftwareDecode {
    out.preferredDecodePath = .software
  }
  if let grace = options.liveStartupGraceSeconds {
    out.liveStartupGraceSeconds = grace
  }
  if let minSegment = options.liveStartupSingleSegmentMinimumSeconds {
    out.liveStartupSingleSegmentMinimumSeconds = minSegment
  }
  if let probesize = options.probesize {
    out.probesize = Int64(probesize)
  }
  if let maxAnalyze = options.maxAnalyzeDurationMicros {
    out.maxAnalyzeDuration = Int64(maxAnalyze)
  }
  return out
}

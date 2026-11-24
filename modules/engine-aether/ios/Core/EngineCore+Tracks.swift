import Foundation

extension EngineCore {
  /// Selects audio track `id` (`"a:<streamId>"`) in place and remembers the choice across reloads.
  public func selectAudioTrack(_ attempt: Int, id: String) {
    guard !released else { return }
    adopt(attempt)
    let streamId = trackState.selectAudio(id)
    if active, let streamId {
      backend.selectAudioTrack(streamId)
    }
  }

  /// Selects primary subtitle track `id` (`"s:<streamId>"` or external ID) in place, or disables primary subtitles when `nil`.
  public func selectSubtitleTrack(_ attempt: Int, id: String?) {
    guard !released else { return }
    adopt(attempt)
    let outcome = trackState.selectSubtitle(id)
    if outcome.clear {
      sink?.clearSubtitles()
    }
    if active {
      if outcome.clearedSecondary {
        backend.selectSecondarySubtitleTrack(nil)
      }
      if outcome.clear {
        backend.selectSubtitleTrack(nil)
      } else if let streamId = outcome.streamId {
        backend.selectSubtitleTrack(streamId)
      } else if let externalId = outcome.externalId {
        backend.selectExternalSubtitleTrack(externalId)
      }
      if let immediate = outcome.immediateTracks {
        emit(.tracks(attempt: token, tracks: immediate))
      }
    }
  }

  /// Selects secondary subtitle track `id` (or disables secondary subtitles when `nil`), enforcing `secondary != primary` (`#402`).
  public func selectSecondarySubtitleTrack(_ attempt: Int, id: String?) {
    guard !released else { return }
    adopt(attempt)
    let outcome = trackState.selectSecondarySubtitle(id)
    guard outcome.valid else { return }
    if active {
      backend.selectSecondarySubtitleTrack(outcome.secondaryId)
      if let immediate = outcome.immediateTracks {
        emit(.tracks(attempt: token, tracks: immediate))
      }
    }
  }

  /// Attaches an external sidecar subtitle track to the active media and remembers it across recovery retries (`#32`, `#308`).
  public func addExternalSubtitle(_ attempt: Int, track: ExternalSubtitleDescriptor) {
    guard !released else { return }
    adopt(attempt)
    let cleanId = track.id.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanUri = track.uri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanId.isEmpty, !cleanUri.isEmpty else { return }
    var normalized = track
    normalized.id = cleanId
    normalized.uri = cleanUri
    if var request = currentRequest {
      if !request.externalSubtitles.contains(where: { $0.id == cleanId }) {
        request.externalSubtitles.append(normalized)
        currentRequest = request
      }
    }
    guard active else { return }
    backend.addExternalSubtitle(normalized)
  }

  /// Shifts audio timing relative to video in milliseconds (`[-30_000, 30_000]`, `#59`).
  public func setAudioDelay(_ attempt: Int, delayMs: Double) {
    guard !released else { return }
    adopt(attempt)
    let seconds = SyncDelayPolicy.delaySeconds(fromMs: delayMs)
    audioDelaySeconds = seconds
    guard active else { return }
    backend.setAudioDelay(seconds)
  }

  /// Shifts subtitle cue timing in milliseconds (`[-30_000, 30_000]`, `#59`).
  public func setSubtitleDelay(_ attempt: Int, delayMs: Double) {
    guard !released else { return }
    adopt(attempt)
    let seconds = SyncDelayPolicy.delaySeconds(fromMs: delayMs)
    subtitleDelaySeconds = seconds
    guard active else { return }
    backend.setSubtitleDelay(seconds)
  }

  /// Constrains adaptive HLS resolution ceiling, or restores automatic ABR when `id` is `nil` (`#59`).
  public func selectVideoQuality(_ attempt: Int, id: String?) {
    guard !released else { return }
    adopt(attempt)
    let outcome = trackState.selectVideoQuality(id)
    guard outcome.valid else { return }
    if active {
      backend.selectVideoQuality(outcome.cap)
      if let immediate = outcome.immediateTracks {
        emit(.tracks(attempt: token, tracks: immediate))
      }
    }
  }

  func reapplySessionSyncAndQuality() {
    if audioDelaySeconds != 0 {
      backend.setAudioDelay(audioDelaySeconds)
    }
    if subtitleDelaySeconds != 0 {
      backend.setSubtitleDelay(subtitleDelaySeconds)
    }
    if let cap = VideoQualityPolicy.resolveCap(for: trackState.videoQualityId) {
      backend.selectVideoQuality(cap)
    }
  }

  func configuredLoadOptions(for plan: MediaPlan, request: LoadRequest) -> EngineLoadOptions {
    var options = loadOptions(for: plan, request: request)
    if dolbyVisionFallbackLatched {
      options.preferSoftwareDecode = true
    }
    trackState.apply(to: &options)
    return options
  }

  func handleTracksObservation(_ observed: MediaTracksOut) {
    let outcome = trackState.reconcile(observed: observed)
    if let audioStream = outcome.selectAudioStreamId {
      backend.selectAudioTrack(audioStream)
    }
    if outcome.clearSubtitle {
      sink?.clearSubtitles()
      backend.selectSubtitleTrack(nil)
    } else if let subtitleStream = outcome.selectSubtitleStreamId {
      backend.selectSubtitleTrack(subtitleStream)
    } else if let externalSubId = outcome.selectExternalSubtitleId {
      backend.selectExternalSubtitleTrack(externalSubId)
    }
    if outcome.clearSecondarySubtitle {
      backend.selectSecondarySubtitleTrack(nil)
    } else if let secondaryId = outcome.selectSecondarySubtitleId {
      backend.selectSecondarySubtitleTrack(secondaryId)
    }
    if let toEmit = outcome.toEmit {
      emit(.tracks(attempt: token, tracks: toEmit))
    }
  }
}

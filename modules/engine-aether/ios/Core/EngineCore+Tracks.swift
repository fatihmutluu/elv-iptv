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

  /// Selects subtitle track `id` (`"s:<streamId>"`) in place, or disables subtitles and clears cues when `nil`.
  public func selectSubtitleTrack(_ attempt: Int, id: String?) {
    guard !released else { return }
    adopt(attempt)
    let outcome = trackState.selectSubtitle(id)
    if outcome.clear {
      sink?.clearSubtitles()
    }
    if active {
      if outcome.clear {
        backend.selectSubtitleTrack(nil)
      } else if let streamId = outcome.streamId {
        backend.selectSubtitleTrack(streamId)
      }
      if let immediate = outcome.immediateTracks {
        emit(.tracks(attempt: token, tracks: immediate))
      }
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
    }
    if let toEmit = outcome.toEmit {
      emit(.tracks(attempt: token, tracks: toEmit))
    }
  }
}

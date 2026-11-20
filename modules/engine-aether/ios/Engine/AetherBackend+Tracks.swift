import AetherEngine
import AVFoundation
import Combine
import Foundation

extension AetherBackend {
  func subscribeTracksAndSubtitles(to target: AetherEngine) {
    let trackSelectionPub = Publishers.CombineLatest3(
      target.$activeAudioTrackIndex,
      target.$isSubtitleActive,
      target.$activeSubtitleTrackIndex
    )

    Publishers.CombineLatest3(
      target.$audioTracks,
      target.$subtitleTracks,
      trackSelectionPub
    )
    .sink { [weak self, weak target] _, _, _ in
      Self.onMainActor {
        guard let self, let target, self.engineLoadSerial > 0 else { return }
        let serial = self.engineLoadSerial
        guard self.readySerial == serial || target.playbackPhase == .playing else { return }
        if self.tracksEmittedSerial == serial && (target.state == .loading || target.playbackPhase == .loading) {
          self.tracksDeferredForReload = true
          return
        }
        self.scheduleTracksSnapshot(from: target, serial: serial)
      }
    }
    .store(in: &cancellables)

    let subRenderStatePub = Publishers.CombineLatest3(
      target.clock.$sourceTimeFollowsPicture,
      target.$isSubtitleActive,
      target.$softwareDisplaySize
    )

    Publishers.CombineLatest3(
      target.$subtitleCues,
      target.clock.$sourceTime,
      subRenderStatePub
    )
    .sink { [weak self, weak target] cues, sourceTime, state in
      Self.onMainActor {
        guard let self, let target else { return }
        let (followsPicture, isSubActive, softwareSize) = state
        guard self.engineLoadSerial > 0, isSubActive, followsPicture, !cues.isEmpty else {
          self.publishSubtitlePresentation(.empty)
          return
        }
        let activeCues = cues.filter { cue in
          cue.startTime <= sourceTime && sourceTime < cue.endTime
        }
        let resolvedSize = Self.resolveVideoSize(from: target, softwareSize: softwareSize)
        self.publishSubtitlePresentation(
          SubtitlePresentation(
            cues: activeCues,
            videoSize: resolvedSize,
            gravity: self.gravity
          )
        )
      }
    }
    .store(in: &cancellables)
  }

  /// Coalesces `@Published` `willSet` track signals onto the next `@MainActor` turn so `target`'s properties
  /// are settled before reading snapshots or issuing non-re-entrant track switch commands.
  func scheduleTracksSnapshot(from target: AetherEngine, serial: Int) {
    guard pendingTracksSerial != serial else { return }
    pendingTracksSerial = serial
    DispatchQueue.main.async { [weak self, weak target] in
      MainActor.assumeIsolated {
        guard let self, let target, self.engineLoadSerial == serial else { return }
        self.pendingTracksSerial = 0
        if self.tracksEmittedSerial == serial && (target.state == .loading || target.playbackPhase == .loading) {
          self.tracksDeferredForReload = true
          return
        }
        let isReady = self.readySerial == serial
          || target.startupProgress?.checkpoint == .ready
          || target.playbackPhase == .playing
        guard isReady else { return }
        self.tracksDeferredForReload = false
        self.tracksEmittedSerial = serial
        self.emitTracksObservation(
          audioTracks: target.audioTracks,
          subtitleTracks: target.subtitleTracks,
          activeAudioIndex: target.activeAudioTrackIndex,
          isSubtitleActive: target.isSubtitleActive,
          activeSubtitleIndex: target.activeSubtitleTrackIndex,
          serial: serial
        )
      }
    }
  }

  func selectAudioTrack(_ streamId: Int) {
    currentLoadOptions?.audioStreamIndex = Int32(exactly: streamId)
    let previousDesired = desiredAudioStreamId
    desiredAudioStreamId = streamId
    guard let engine, activeLoadSerial > 0 else { return }

    if engine.activeAudioTrackIndex == streamId,
       (previousDesired == nil || previousDesired == streamId),
       audioSwitchTask == nil,
       currentPlan?.isLiveTs != true
    {
      return
    }

    if case let .liveTs(url) = currentPlan, let opts = currentLoadOptions {
      reloadLiveTsWithAudioOverride(url: url, options: opts, serial: activeLoadSerial)
      return
    }

    let serial = engineLoadSerial
    guard serial > 0 else { return }
    audioSwitchTask?.cancel()
    if let pendingSeek = seekTask {
      audioSwitchTask = Task { @MainActor [weak self] in
        await pendingSeek.value
        guard let self, !Task.isCancelled, self.engineLoadSerial == serial,
              let currentEngine = self.engine, let targetStream = self.desiredAudioStreamId
        else {
          return
        }
        self.audioSwitchTask = nil
        currentEngine.selectAudioTrack(index: targetStream)
      }
    } else {
      audioSwitchTask = nil
      engine.selectAudioTrack(index: streamId)
    }
  }

  func selectSubtitleTrack(_ streamId: Int?) {
    let previousDesired = desiredSubtitleStreamId
    desiredSubtitleStreamId = streamId
    currentLoadOptions?.initialSubtitleTrackId = streamId
    currentLoadOptions?.subtitlesDisabled = (streamId == nil)
    guard let streamId else {
      publishSubtitlePresentation(.empty)
      engine?.clearSubtitle()
      return
    }
    guard let engine, engineLoadSerial > 0 else { return }
    if engine.isSubtitleActive,
       engine.activeSubtitleTrackIndex == streamId,
       (previousDesired == nil || previousDesired == streamId)
    {
      return
    }
    publishSubtitlePresentation(.empty)
    engine.selectSubtitleTrack(index: streamId)
  }

  func publishSubtitlePresentation(_ next: SubtitlePresentation) {
    guard next != lastSubtitlePresentation else { return }
    lastSubtitlePresentation = next
    onSubtitlePresentation?(next)
  }

  func refreshSubtitleGravity() {
    guard !lastSubtitlePresentation.cues.isEmpty else { return }
    var updated = lastSubtitlePresentation
    updated.gravity = gravity
    publishSubtitlePresentation(updated)
  }

  func refreshSubtitleGeometry(from target: AetherEngine?) {
    guard let target, !lastSubtitlePresentation.cues.isEmpty else { return }
    let resolved = Self.resolveVideoSize(from: target, softwareSize: target.softwareDisplaySize)
    guard resolved != .zero, resolved != lastSubtitlePresentation.videoSize else { return }
    var updated = lastSubtitlePresentation
    updated.videoSize = resolved
    publishSubtitlePresentation(updated)
  }

  private func emitTracksObservation(
    audioTracks: [TrackInfo],
    subtitleTracks: [TrackInfo],
    activeAudioIndex: Int?,
    isSubtitleActive: Bool,
    activeSubtitleIndex: Int?,
    serial: Int
  ) {
    let audio = audioTracks.map { Self.mapTrackInfo($0, isAudio: true) }
    let subtitles = subtitleTracks.map { Self.mapTrackInfo($0, isAudio: false) }
    let selectedAudioId = activeAudioIndex.map(formatAudioTrackId)
    let selectedSubtitleId = isSubtitleActive ? activeSubtitleIndex.map(formatSubtitleTrackId) : nil
    onObservation?(
      .tracks(
        MediaTracksOut(
          audio: audio,
          subtitles: subtitles,
          selectedAudioId: selectedAudioId,
          selectedSubtitleId: selectedSubtitleId
        )
      ),
      serial
    )
  }

  private static func resolveVideoSize(from target: AetherEngine, softwareSize: CGSize?) -> CGSize {
    if let softwareSize, softwareSize.width > 0, softwareSize.height > 0 {
      return softwareSize
    }
    if let itemSize = target.currentAVPlayerItem?.presentationSize,
       itemSize.width > 0,
       itemSize.height > 0
    {
      return itemSize
    }
    if let itemSize = target.nativePlayerLayer?.player?.currentItem?.presentationSize,
       itemSize.width > 0,
       itemSize.height > 0
    {
      return itemSize
    }
    if let rect = target.nativePlayerLayer?.videoRect, rect.width > 0, rect.height > 0 {
      return rect.size
    }
    return .zero
  }

  private static func mapTrackInfo(_ track: TrackInfo, isAudio: Bool) -> TrackInfoOut {
    let id = isAudio ? formatAudioTrackId(track.id) : formatSubtitleTrackId(track.id)
    let label = track.name.trimmingCharacters(in: .whitespacesAndNewlines)
    let codec = track.codec.trimmingCharacters(in: .whitespacesAndNewlines)
    return TrackInfoOut(
      id: id,
      language: normalizeTrackLanguage(track.language),
      label: label.isEmpty ? nil : label,
      codec: codec.isEmpty ? nil : codec,
      channels: (isAudio && track.channels > 0) ? track.channels : nil,
      forced: track.isForced,
      isDefault: track.isDefault
    )
  }

  private func reloadLiveTsWithAudioOverride(
    url: URL,
    options: EngineLoadOptions,
    serial: Int
  ) {
    guard let currentEngine = engine else { return }
    engineLoadSerial = 0
    readySerial = 0
    tracksEmittedSerial = 0
    pendingTracksSerial = 0
    tracksDeferredForReload = false
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    currentEngine.stop(resetDisplayCriteria: false, finalTeardown: false)
    runMediaLoad(plan: .liveTs(url), fallbackOptions: options, serial: serial, currentEngine: currentEngine)
  }
}

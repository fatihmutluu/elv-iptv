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
    .sink { [weak self, weak target] audioTracks, subtitleTracks, selection in
      MainActor.assumeIsolated {
        guard let self, let target, self.engineLoadSerial > 0 else { return }
        let (activeAudioIndex, isSubActive, activeSubIndex) = selection
        let isReady = target.startupProgress?.checkpoint == .ready || target.playbackPhase == .playing
        guard !audioTracks.isEmpty || !subtitleTracks.isEmpty || isReady else { return }
        self.emitTracksObservation(
          audioTracks: audioTracks,
          subtitleTracks: subtitleTracks,
          activeAudioIndex: activeAudioIndex,
          isSubtitleActive: isSubActive,
          activeSubtitleIndex: activeSubIndex,
          serial: self.engineLoadSerial
        )
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
      MainActor.assumeIsolated {
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

  func emitCurrentTracksSnapshot(from target: AetherEngine, serial: Int) {
    emitTracksObservation(
      audioTracks: target.audioTracks,
      subtitleTracks: target.subtitleTracks,
      activeAudioIndex: target.activeAudioTrackIndex,
      isSubtitleActive: target.isSubtitleActive,
      activeSubtitleIndex: target.activeSubtitleTrackIndex,
      serial: serial
    )
  }

  func selectAudioTrack(_ streamId: Int) {
    currentLoadOptions?.audioStreamIndex = Int32(exactly: streamId)
    guard let engine, activeLoadSerial > 0 else { return }
    if engine.activeAudioTrackIndex == streamId, audioSwitchTask == nil {
      return
    }
    if case let .liveTs(url) = currentPlan, let opts = currentLoadOptions {
      reloadLiveTsWithAudioOverride(url: url, options: opts, streamId: streamId, serial: activeLoadSerial)
      return
    }
    let serial = engineLoadSerial
    guard serial > 0 else { return }
    audioSwitchTask?.cancel()
    if let pendingSeek = seekTask {
      audioSwitchTask = Task { @MainActor [weak self] in
        await pendingSeek.value
        guard let self, !Task.isCancelled, self.engineLoadSerial == serial, let currentEngine = self.engine else {
          return
        }
        self.audioSwitchTask = nil
        if currentEngine.activeAudioTrackIndex != streamId {
          currentEngine.selectAudioTrack(index: streamId)
        }
      }
    } else {
      audioSwitchTask = nil
      engine.selectAudioTrack(index: streamId)
    }
  }

  func selectSubtitleTrack(_ streamId: Int?) {
    currentLoadOptions?.initialSubtitleTrackId = streamId
    currentLoadOptions?.subtitlesDisabled = (streamId == nil)
    guard let streamId else {
      publishSubtitlePresentation(.empty)
      engine?.clearSubtitle()
      return
    }
    guard let engine, engineLoadSerial > 0 else { return }
    if engine.isSubtitleActive && engine.activeSubtitleTrackIndex == streamId {
      return
    }
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
    if let itemSize = target.nativePlayerLayer?.player?.currentItem?.presentationSize,
       itemSize.width > 0,
       itemSize.height > 0 {
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
    streamId: Int,
    serial: Int
  ) {
    guard let currentEngine = engine else { return }
    engineLoadSerial = 0
    cancelTasksAndReader()
    currentEngine.stop(resetDisplayCriteria: false, finalTeardown: false)
    gateGeneration += 1
    let generation = gateGeneration
    gate.advance(to: generation)
    let loadOpts = aetherOptions(options)
    let audioStream = Int32(exactly: streamId)

    loadTask = Task { @MainActor [weak self] in
      guard let self, self.activeLoadSerial == serial, !Task.isCancelled else { return }
      let session = self.httpSession
      let reader = LiveTsReader(
        url: url,
        headers: options.httpHeaders,
        generation: generation,
        gate: self.gate,
        makeTransport: { URLSessionTransport(session: session) }
      )
      self.currentReader = reader
      let verdict = await reader.open()
      guard self.activeLoadSerial == serial, !Task.isCancelled else {
        reader.close()
        if self.currentReader === reader { self.currentReader = nil }
        return
      }
      do {
        switch verdict {
        case let .media(hint):
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(
            source: .custom(reader, formatHint: hint),
            options: loadOpts,
            audioSourceStreamIndex: audioStream
          )
        case .playlist:
          reader.close()
          if self.currentReader === reader { self.currentReader = nil }
          self.gateGeneration += 1
          let playlistGen = self.gateGeneration
          self.gate.advance(to: playlistGen)
          guard await self.gate.waitForClosed(before: playlistGen),
                self.activeLoadSerial == serial,
                !Task.isCancelled
          else { return }
          var hlsOpts = options
          hlsOpts.isLive = true
          self.currentPlan = .hls(url, live: true)
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(
            url: url,
            options: aetherOptions(hlsOpts),
            audioSourceStreamIndex: audioStream
          )
        case let .failed(rf):
          reader.close()
          if self.currentReader === reader { self.currentReader = nil }
          guard self.errorReportedSerial != serial else { return }
          self.errorReportedSerial = serial
          self.onObservation?(.failure(.reader(rf)), serial)
        case .superseded:
          reader.close()
          if self.currentReader === reader { self.currentReader = nil }
        }
      } catch is CancellationError {
        return
      } catch {
        guard self.activeLoadSerial == serial, self.errorReportedSerial != serial else { return }
        self.errorReportedSerial = serial
        self.forwardReaderFaultIfPresent(serial: serial)
        let nsError = error as NSError
        self.onObservation?(
          .failure(.engine(kind: "sourceOpenFailed", underlyingDomain: nsError.domain, underlyingCode: nsError.code)),
          serial
        )
      }
    }
  }
}

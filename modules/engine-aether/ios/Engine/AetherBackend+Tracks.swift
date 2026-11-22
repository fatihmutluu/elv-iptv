import AetherEngine
import AVFoundation
import Combine
import CoreMedia
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

    Publishers.CombineLatest4(
      target.$subtitleCues,
      target.clock.$sourceTimeFollowsPicture,
      target.$isSubtitleActive,
      target.$softwareDisplaySize
    )
    .sink { [weak self, weak target] cues, followsPicture, isSubActive, softwareSize in
      Self.onMainActor {
        guard let self, let target else { return }
        self.updateSubtitleClockSubscription(
          target: target,
          cues: cues,
          followsPicture: followsPicture,
          isSubActive: isSubActive,
          softwareSize: softwareSize
        )
      }
    }
    .store(in: &cancellables)
  }

  private func updateSubtitleClockSubscription(
    target: AetherEngine,
    cues: [SubtitleCue],
    followsPicture: Bool,
    isSubActive: Bool,
    softwareSize: CGSize?
  ) {
    guard engineLoadSerial > 0, isSubActive, followsPicture, !cues.isEmpty else {
      subtitleClockCancellable?.cancel()
      subtitleClockCancellable = nil
      publishSubtitlePresentation(.empty)
      return
    }
    renderSubtitles(
      from: target,
      cues: cues,
      sourceTime: target.clock.sourceTime,
      softwareSize: softwareSize
    )
    if subtitleClockCancellable == nil {
      subtitleClockCancellable = target.clock.$sourceTime
        .dropFirst()
        .sink { [weak self, weak target] sourceTime in
          Self.onMainActor {
            guard let self, let target, self.engineLoadSerial > 0 else { return }
            guard target.isSubtitleActive, target.clock.sourceTimeFollowsPicture, !target.subtitleCues.isEmpty else {
              self.subtitleClockCancellable?.cancel()
              self.subtitleClockCancellable = nil
              self.publishSubtitlePresentation(.empty)
              return
            }
            self.renderSubtitles(
              from: target,
              cues: target.subtitleCues,
              sourceTime: sourceTime,
              softwareSize: target.softwareDisplaySize
            )
          }
        }
    }
  }

  private func renderSubtitles(
    from target: AetherEngine,
    cues: [SubtitleCue],
    sourceTime: Double,
    softwareSize: CGSize?
  ) {
    let filterSdh = currentLoadOptions?.filterSdhSubtitles ?? false
    let activeCues = cues.filter { cue in
      guard cue.startTime <= sourceTime && sourceTime < cue.endTime else { return false }
      guard filterSdh else { return true }
      switch cue.body {
      case let .text(raw):
        return !SubtitlePresentation.stripSdhAnnotations(raw).isEmpty
      case let .richText(runs):
        return !SubtitlePresentation.stripSdhAnnotations(runs.map(\.text).joined()).isEmpty
      case .image:
        return true
      }
    }
    let resolvedSize = Self.resolveVideoSize(from: target, softwareSize: softwareSize)
    publishSubtitlePresentation(
      SubtitlePresentation(
        cues: activeCues,
        videoSize: resolvedSize,
        gravity: gravity,
        filterSdhSubtitles: filterSdh
      )
    )
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
        self.inspectAndEmitVideoInfo(from: target, serial: serial)
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
    if seekTask != nil {
      audioSwitchTask = Task { @MainActor [weak self] in
        while let self, let pendingSeek = self.seekTask {
          await pendingSeek.value
          guard !Task.isCancelled, self.engineLoadSerial == serial else {
            return
          }
        }
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
    let cleanLabel = label.isEmpty ? nil : label
    let normalizedLang = normalizeTrackLanguage(track.language)
    let resolvedLang = (canonicalTrackLanguage(normalizedLang) != nil ? normalizedLang : nil)
      ?? extractTrackLanguageFromLabel(cleanLabel)
    return TrackInfoOut(
      id: id,
      language: resolvedLang,
      label: cleanLabel,
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
    inReloadFromState = false
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    currentEngine.stop(resetDisplayCriteria: false, finalTeardown: false)
    runMediaLoad(plan: .liveTs(url), fallbackOptions: options, serial: serial, currentEngine: currentEngine)
  }

  func inspectAndEmitVideoInfo(from target: AetherEngine, serial: Int) {
    let size = Self.resolveVideoSize(from: target, softwareSize: target.softwareDisplaySize)
    if size.width > 0, size.height > 0 {
      onObservation?(
        .mediaInfo(
          StreamVideoInfo(
            width: Int(size.width.rounded()),
            height: Int(size.height.rounded()),
            hdr: nil
          )
        ),
        serial
      )
    }
    guard let item = target.currentAVPlayerItem ?? target.nativePlayerLayer?.player?.currentItem else {
      return
    }
    let asset = item.asset
    let isVod = !target.isLive
    mediaInfoTask?.cancel()
    mediaInfoTask = Task { @MainActor [weak self] in
      if let videoTracks = try? await asset.loadTracks(withMediaType: .video),
         let track = videoTracks.first,
         !Task.isCancelled,
         let loaded = try? await track.load(.naturalSize, .nominalFrameRate, .formatDescriptions)
      {
        guard let self, !Task.isCancelled, self.engineLoadSerial == serial else { return }
        let (naturalSize, nominalRate, descriptions) = loaded
        let width = naturalSize.width > 0 ? Int(naturalSize.width.rounded()) : nil
        let height = naturalSize.height > 0 ? Int(naturalSize.height.rounded()) : nil
        let fps: Double? = (nominalRate.isFinite && nominalRate > 0)
          ? (Double(nominalRate) * 100.0).rounded() / 100.0
          : nil
        let (codec, hdr) = Self.classifyFormatDescriptions(descriptions)
        let info = StreamVideoInfo(width: width, height: height, fps: fps, codec: codec, hdr: hdr)
        if !info.isEmpty {
          self.onObservation?(.mediaInfo(info), serial)
        }
      }
      guard isVod, !Task.isCancelled else { return }
      let chapters = await Self.loadAssetChapters(asset)
      guard let self, !Task.isCancelled, self.engineLoadSerial == serial, !chapters.isEmpty else { return }
      self.onObservation?(.chapters(chapters), serial)
    }
  }

  private static func loadAssetChapters(_ asset: AVAsset) async -> [ChapterInfoOut] {
    guard let locales = try? await asset.load(.availableChapterLocales),
          let locale = locales.first,
          let groups = try? await asset.loadChapterMetadataGroups(
            withTitleLocale: locale,
            containingItemsWithCommonKeys: [.commonKeyTitle]
          ),
          !groups.isEmpty
    else { return [] }
    var out: [ChapterInfoOut] = []
    out.reserveCapacity(groups.count)
    for (idx, group) in groups.enumerated() {
      let startSec = CMTimeGetSeconds(group.timeRange.start)
      guard startSec.isFinite, startSec >= 0 else { continue }
      let durSec = CMTimeGetSeconds(group.timeRange.duration)
      let endMs: Double? = (durSec.isFinite && durSec > 0) ? ((startSec + durSec) * 1_000.0).rounded() : nil
      let titleItem = AVMetadataItem.metadataItems(
        from: group.items,
        filteredByIdentifier: .commonIdentifierTitle
      ).first
      let rawTitle: String? = if let titleItem {
        try? await titleItem.load(.stringValue)
      } else {
        nil
      }
      let trimmed = rawTitle?.trimmingCharacters(in: .whitespacesAndNewlines)
      out.append(
        ChapterInfoOut(
          id: "ch:\(idx)",
          title: (trimmed?.isEmpty == false) ? trimmed : nil,
          startMs: (startSec * 1_000.0).rounded(),
          endMs: endMs
        )
      )
    }
    return out
  }

  private static func classifyFormatDescriptions(_ descriptions: [CMFormatDescription]) -> (codec: String?, hdr: String) {
    guard let desc = descriptions.first else { return (nil, "sdr") }
    let subType = CMFormatDescriptionGetMediaSubType(desc)
    var isDolbyVision = false
    let codec: String?
    switch subType {
    case kCMVideoCodecType_HEVC, 0x6865_7631: // 'hev1'
      codec = "hevc"
    case 0x6476_6831, 0x6476_6865: // 'dvh1', 'dvhe'
      codec = "hevc"
      isDolbyVision = true
    case kCMVideoCodecType_H264:
      codec = "h264"
    case kCMVideoCodecType_VP9:
      codec = "vp9"
    case 0x6176_3031: // 'av01'
      codec = "av1"
    case kCMVideoCodecType_MPEG2Video:
      codec = "mpeg2"
    default:
      codec = nil
    }
    if isDolbyVision {
      return (codec, "dv")
    }
    if let transfer = CMFormatDescriptionGetExtension(
      desc,
      extensionKey: kCMFormatDescriptionExtension_TransferFunction
    ) as? String {
      if transfer == (kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String) {
        return (codec, "hdr10")
      }
      if transfer == (kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String) {
        return (codec, "hlg")
      }
    }
    return (codec, "sdr")
  }
}

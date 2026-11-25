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
        guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
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
        guard let self, let target, self.engine === target else { return }
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

  func refreshAllSubtitles(from target: AetherEngine) {
    updateSubtitleClockSubscription(
      target: target,
      cues: target.subtitleCues,
      followsPicture: target.clock.sourceTimeFollowsPicture,
      isSubActive: target.isSubtitleActive,
      softwareSize: target.softwareDisplaySize
    )
  }

  func updateSubtitleClockSubscription(
    target: AetherEngine,
    cues: [SubtitleCue],
    followsPicture: Bool,
    isSubActive: Bool,
    softwareSize: CGSize?
  ) {
    let hasEmbedded = isSubActive && followsPicture && !cues.isEmpty
    let hasExternal = hasActiveExternalOrSecondarySubtitles
    guard self.engine === target, engineLoadSerial > 0, (hasEmbedded || hasExternal) else {
      subtitleClockCancellable?.cancel()
      subtitleClockCancellable = nil
      externalSubtitleClockCancellable?.cancel()
      externalSubtitleClockCancellable = nil
      publishSubtitlePresentation(.empty)
      return
    }
    let activeTime = followsPicture ? target.clock.sourceTime : target.clock.currentTime
    renderSubtitles(
      from: target,
      cues: hasEmbedded ? cues : [],
      sourceTime: activeTime,
      softwareSize: softwareSize
    )
    if hasEmbedded {
      if subtitleClockCancellable == nil {
        subtitleClockCancellable = target.clock.$sourceTime
          .dropFirst()
          .sink { [weak self, weak target] sourceTime in
            Self.onMainActor {
              guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
              let embeddedOk = target.isSubtitleActive && target.clock.sourceTimeFollowsPicture && !target.subtitleCues.isEmpty
              guard embeddedOk || self.hasActiveExternalOrSecondarySubtitles else {
                self.subtitleClockCancellable?.cancel()
                self.subtitleClockCancellable = nil
                self.publishSubtitlePresentation(.empty)
                return
              }
              self.renderSubtitles(
                from: target,
                cues: embeddedOk ? target.subtitleCues : [],
                sourceTime: sourceTime,
                softwareSize: target.softwareDisplaySize
              )
            }
          }
      }
    } else {
      subtitleClockCancellable?.cancel()
      subtitleClockCancellable = nil
    }

    if hasExternal {
      if externalSubtitleClockCancellable == nil {
        externalSubtitleClockCancellable = target.clock.$currentTime
          .dropFirst()
          .sink { [weak self, weak target] currentTime in
            Self.onMainActor {
              guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
              guard self.hasActiveExternalOrSecondarySubtitles else {
                self.externalSubtitleClockCancellable?.cancel()
                self.externalSubtitleClockCancellable = nil
                return
              }
              let embeddedOk = target.isSubtitleActive && target.clock.sourceTimeFollowsPicture && !target.subtitleCues.isEmpty
              let effectiveClock = target.clock.sourceTimeFollowsPicture ? target.clock.sourceTime : currentTime
              self.renderSubtitles(
                from: target,
                cues: embeddedOk ? target.subtitleCues : [],
                sourceTime: effectiveClock,
                softwareSize: target.softwareDisplaySize
              )
            }
          }
      }
    } else {
      externalSubtitleClockCancellable?.cancel()
      externalSubtitleClockCancellable = nil
    }
  }

  private func renderSubtitles(
    from target: AetherEngine,
    cues: [SubtitleCue],
    sourceTime: Double,
    softwareSize: CGSize?
  ) {
    let filterSdh = currentLoadOptions?.filterSdhSubtitles ?? false
    let effectiveTime = SyncDelayPolicy.effectiveSubtitleTime(
      sourceTimeSeconds: sourceTime,
      subtitleDelaySeconds: requestedSubtitleDelaySeconds
    )
    let activeEmbedded = cues.filter { cue in
      guard cue.startTime <= effectiveTime && effectiveTime < cue.endTime else { return false }
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
    let maxSec = Double(ExternalSubtitleParser.maxSubtitleTimeMs) / 1_000.0
    let effectiveMs: Int = (effectiveTime.isFinite && effectiveTime >= 0 && effectiveTime <= maxSec)
      ? Int((effectiveTime * 1_000.0).rounded())
      : 0
    let primaryEmbedded: [SubtitleCue]
    let secondaryEmbedded: [SubtitleCue]
    if embeddedDecoderServingSecondary {
      primaryEmbedded = []
      secondaryEmbedded = activeEmbedded
    } else if activeExternalPrimaryId == nil {
      primaryEmbedded = activeEmbedded
      secondaryEmbedded = []
    } else {
      primaryEmbedded = []
      secondaryEmbedded = []
    }

    let externalPrimary: [ExternalSubtitleCue]
    if let extPrimaryId = activeExternalPrimaryId, let loaded = externalSubtitles[extPrimaryId] {
      externalPrimary = filterExternalCues(
        ExternalSubtitleParser.activeCues(in: loaded.cues, atMs: effectiveMs),
        filterSdh: filterSdh
      )
    } else {
      externalPrimary = []
    }

    let externalSecondary: [ExternalSubtitleCue]
    let currentPrimary = currentPrimarySubtitleId()
    if let secId = activeSecondarySubtitleId, secId != currentPrimary, let loaded = externalSubtitles[secId] {
      externalSecondary = filterExternalCues(
        ExternalSubtitleParser.activeCues(in: loaded.cues, atMs: effectiveMs),
        filterSdh: filterSdh
      )
    } else {
      externalSecondary = []
    }

    let resolvedSize = Self.resolveVideoSize(from: target, softwareSize: softwareSize)
    publishSubtitlePresentation(
      SubtitlePresentation(
        cues: primaryEmbedded,
        secondaryCues: secondaryEmbedded,
        externalPrimaryCues: externalPrimary,
        externalSecondaryCues: externalSecondary,
        videoSize: resolvedSize,
        gravity: gravity,
        filterSdhSubtitles: filterSdh
      )
    )
  }

  private func filterExternalCues(_ cues: [ExternalSubtitleCue], filterSdh: Bool) -> [ExternalSubtitleCue] {
    guard filterSdh else { return cues }
    return cues.filter { !SubtitlePresentation.stripSdhAnnotations($0.text).isEmpty }
  }

  /// Coalesces `@Published` `willSet` track signals onto the next `@MainActor` turn so `target`'s properties
  /// are settled before reading snapshots or issuing non-re-entrant track switch commands.
  func scheduleTracksSnapshot(from target: AetherEngine, serial: Int) {
    guard pendingTracksSerial != serial else { return }
    pendingTracksSerial = serial
    DispatchQueue.main.async { [weak self, weak target] in
      MainActor.assumeIsolated {
        guard let self, let target, self.engine === target, self.engineLoadSerial == serial else { return }
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
      audioSwitchTaskId &+= 1
      let id = audioSwitchTaskId
      audioSwitchTask = Task { @MainActor [weak self] in
        defer {
          if let self, self.audioSwitchTaskId == id {
            self.audioSwitchTask = nil
          }
        }
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
        currentEngine.selectAudioTrack(index: targetStream)
      }
    } else {
      audioSwitchTaskId &+= 1
      audioSwitchTask = nil
      engine.selectAudioTrack(index: streamId)
    }
  }

  func selectSubtitleTrack(_ streamId: Int?) {
    let previousDesired = desiredSubtitleStreamId
    let wasExternalPrimary = activeExternalPrimaryId != nil
    activeExternalPrimaryId = nil
    desiredSubtitleStreamId = streamId
    currentLoadOptions?.initialSubtitleTrackId = streamId
    currentLoadOptions?.subtitlesDisabled = (streamId == nil)
    guard let streamId else {
      if !embeddedDecoderServingSecondary {
        engine?.clearSubtitle()
      }
      emitCurrentTracksSnapshot()
      if let target = engine, hasActiveExternalOrSecondarySubtitles {
        refreshAllSubtitles(from: target)
      } else {
        publishSubtitlePresentation(.empty)
      }
      return
    }
    let wasEmbeddedSecondary = embeddedDecoderServingSecondary
    embeddedDecoderServingSecondary = false
    if activeSecondarySubtitleId.flatMap(parseSubtitleTrackStreamId) != nil {
      activeSecondarySubtitleId = nil
    }
    guard let engine, engineLoadSerial > 0 else { return }
    if !wasExternalPrimary,
       !wasEmbeddedSecondary,
       engine.isSubtitleActive,
       engine.activeSubtitleTrackIndex == streamId,
       (previousDesired == nil || previousDesired == streamId)
    {
      return
    }
    if !hasActiveExternalOrSecondarySubtitles {
      publishSubtitlePresentation(.empty)
    }
    engine.selectSubtitleTrack(index: streamId)
    emitCurrentTracksSnapshot()
    refreshAllSubtitles(from: engine)
  }

  func setAudioDelay(_ seconds: Double) {
    let clamped = SyncDelayPolicy.clampDelaySeconds(seconds)
    requestedAudioDelaySeconds = clamped
    engine?.setAudioDelay(clamped)
  }

  func setSubtitleDelay(_ seconds: Double) {
    let clamped = SyncDelayPolicy.clampDelaySeconds(seconds)
    requestedSubtitleDelaySeconds = clamped
    engine?.setSoftwareSubtitleDelay(clamped)
    if let target = engine, engineLoadSerial > 0 {
      let hasEmbedded = target.isSubtitleActive && target.clock.sourceTimeFollowsPicture && !target.subtitleCues.isEmpty
      if hasEmbedded || hasActiveExternalOrSecondarySubtitles {
        let activeTime = target.clock.sourceTimeFollowsPicture ? target.clock.sourceTime : target.clock.currentTime
        renderSubtitles(
          from: target,
          cues: hasEmbedded ? target.subtitleCues : [],
          sourceTime: activeTime,
          softwareSize: target.softwareDisplaySize
        )
      }
    }
  }

  func selectVideoQuality(_ cap: VideoQualityCap?) {
    requestedVideoQualityCap = cap
    if let item = engine?.currentAVPlayer?.currentItem ?? engine?.currentAVPlayerItem {
      applyVideoQualityCap(to: item)
    }
  }

  func applyVideoQualityCap(to item: AVPlayerItem) {
    if let cap = requestedVideoQualityCap {
      item.preferredMaximumResolution = CGSize(width: cap.maxWidth, height: cap.maxHeight)
      item.preferredPeakBitRate = cap.peakBitrateBps
    } else {
      item.preferredMaximumResolution = .zero
      item.preferredPeakBitRate = 0
    }
  }

  func applyRequestedSyncAndQuality(to target: AetherEngine) {
    if requestedAudioDelaySeconds != 0 {
      target.setAudioDelay(requestedAudioDelaySeconds)
    }
    if requestedSubtitleDelaySeconds != 0 {
      target.setSoftwareSubtitleDelay(requestedSubtitleDelaySeconds)
    }
    if let item = target.currentAVPlayer?.currentItem ?? target.currentAVPlayerItem {
      applyVideoQualityCap(to: item)
    }
    if desiredSubtitleStreamId == nil,
       (activeExternalPrimaryId != nil || currentLoadOptions?.subtitlesDisabled == true),
       let secId = activeSecondarySubtitleId,
       let secStreamId = parseSubtitleTrackStreamId(secId)
    {
      embeddedDecoderServingSecondary = true
      target.selectSubtitleTrack(index: secStreamId)
    }
  }

  func publishSubtitlePresentation(_ next: SubtitlePresentation) {
    guard next != lastSubtitlePresentation else { return }
    lastSubtitlePresentation = next
    onSubtitlePresentation?(next)
  }

  func refreshSubtitleGravity() {
    guard lastSubtitlePresentation.hasAnyCues else { return }
    var updated = lastSubtitlePresentation
    updated.gravity = gravity
    publishSubtitlePresentation(updated)
  }

  func refreshSubtitleGeometry(from target: AetherEngine?) {
    guard let target, lastSubtitlePresentation.hasAnyCues else { return }
    let resolved = Self.resolveVideoSize(from: target, softwareSize: target.softwareDisplaySize)
    guard resolved != .zero, resolved != lastSubtitlePresentation.videoSize else { return }
    var updated = lastSubtitlePresentation
    updated.videoSize = resolved
    publishSubtitlePresentation(updated)
  }

  func emitTracksObservation(
    audioTracks: [TrackInfo],
    subtitleTracks: [TrackInfo],
    activeAudioIndex: Int?,
    isSubtitleActive: Bool,
    activeSubtitleIndex: Int?,
    serial: Int
  ) {
    let audio = audioTracks.map { Self.mapTrackInfo($0, isAudio: true) }
    let subtitles = subtitleTracks.map { Self.mapTrackInfo($0, isAudio: false) } + externalSubtitleTrackInfos
    let selectedAudioId = activeAudioIndex.map(formatAudioTrackId)
    let selectedSubtitleId: String? =
      activeExternalPrimaryId
      ?? (embeddedDecoderServingSecondary ? nil : (isSubtitleActive ? activeSubtitleIndex.map(formatSubtitleTrackId) : nil))
    let selectedSecondarySubtitleId: String? = {
      guard let secId = activeSecondarySubtitleId, secId != selectedSubtitleId else { return nil }
      if parseSubtitleTrackStreamId(secId) != nil {
        guard embeddedDecoderServingSecondary,
              selectedSubtitleId.flatMap(parseSubtitleTrackStreamId) == nil
        else {
          return nil
        }
      }
      return secId
    }()
    let isAdaptive = VideoQualityPolicy.isAdaptiveStream(plan: currentPlan)
    let videoQualities = isAdaptive ? VideoQualityPolicy.adaptivePresets : []
    let selectedVideoQualityId = isAdaptive ? requestedVideoQualityCap?.id : nil
    onObservation?(
      .tracks(
        MediaTracksOut(
          audio: audio,
          subtitles: subtitles,
          selectedAudioId: selectedAudioId,
          selectedSubtitleId: selectedSubtitleId,
          selectedSecondarySubtitleId: selectedSecondarySubtitleId,
          videoQualities: videoQualities,
          selectedVideoQualityId: selectedVideoQualityId
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
    let shouldResetCriteria = shouldResetDisplayCriteria(reason: .zap, settings: displaySyncSettings)
    currentEngine.stop(resetDisplayCriteria: shouldResetCriteria, finalTeardown: false)
    if shouldResetCriteria {
      resetDisplayCriteria()
    }
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
    mediaInfoTaskId &+= 1
    let id = mediaInfoTaskId
    mediaInfoTask = Task { @MainActor [weak self, weak target] in
      defer {
        if let self, self.mediaInfoTaskId == id {
          self.mediaInfoTask = nil
        }
      }
      if let videoTracks = try? await asset.loadTracks(withMediaType: .video),
         let track = videoTracks.first,
         !Task.isCancelled,
         let loaded = try? await track.load(.naturalSize, .nominalFrameRate, .formatDescriptions)
      {
        guard let self, let target, !Task.isCancelled, self.engine === target, self.engineLoadSerial == serial else { return }
        let (naturalSize, nominalRate, descriptions) = loaded
        let width = naturalSize.width > 0 ? Int(naturalSize.width.rounded()) : nil
        let height = naturalSize.height > 0 ? Int(naturalSize.height.rounded()) : nil
        let fps: Double? = (nominalRate.isFinite && nominalRate > 0)
          ? (Double(nominalRate) * 100.0).rounded() / 100.0
          : nil
        let (codec, hdr) = Self.classifyFormatDescriptions(descriptions)
        let info = StreamVideoInfo(width: width, height: height, fps: fps, codec: codec, hdr: hdr)
        self.handleStabilizedVideoMetadata(
          fps: fps,
          hdr: hdr,
          formatDescription: descriptions.first
        )
        if !info.isEmpty {
          self.onObservation?(.mediaInfo(info), serial)
        }
      }
      guard isVod, !Task.isCancelled, let self, let target, self.engine === target, self.engineLoadSerial == serial else { return }
      let chapters = await Self.loadAssetChapters(asset)
      guard !Task.isCancelled, self.engine === target, self.engineLoadSerial == serial, !chapters.isEmpty else { return }
      self.onObservation?(.chapters(chapters), serial)
    }
  }

  private static func loadAssetChapters(_ asset: AVAsset) async -> [ChapterInfoOut] {
    guard !Task.isCancelled,
          let locales = try? await asset.load(.availableChapterLocales),
          !Task.isCancelled,
          let locale = locales.first,
          let groups = try? await asset.loadChapterMetadataGroups(
            withTitleLocale: locale,
            containingItemsWithCommonKeys: [.commonKeyTitle]
          ),
          !Task.isCancelled,
          !groups.isEmpty
    else { return [] }
    var out: [ChapterInfoOut] = []
    out.reserveCapacity(groups.count)
    for (idx, group) in groups.enumerated() {
      guard !Task.isCancelled else { return [] }
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

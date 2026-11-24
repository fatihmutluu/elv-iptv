import AetherEngine
import Foundation

private enum SubtitleFetchError: Error {
  case invalidResponse
  case exceedsMaxBytes
}

/// Parsed sidecar subtitle track held in memory for the active media serial (`#32`, `#308`, `#402`).
struct LoadedExternalSubtitle {
  let descriptor: ExternalSubtitleDescriptor
  let cues: [ExternalSubtitleCue]
  let trackInfo: TrackInfoOut
}

extension AetherBackend {
  var externalSubtitleTrackInfos: [TrackInfoOut] {
    externalSubtitleOrder.compactMap { externalSubtitles[$0]?.trackInfo }
  }

  var hasActiveExternalOrSecondarySubtitles: Bool {
    if let primaryExt = activeExternalPrimaryId,
       let loaded = externalSubtitles[primaryExt],
       !loaded.cues.isEmpty
    {
      return true
    }
    if let secondaryId = activeSecondarySubtitleId {
      if let loaded = externalSubtitles[secondaryId], !loaded.cues.isEmpty {
        return true
      }
      if embeddedDecoderServingSecondary,
         parseSubtitleTrackStreamId(secondaryId) != nil,
         let engine,
         engine.isSubtitleActive,
         !engine.subtitleCues.isEmpty
      {
        return true
      }
    }
    return false
  }

  func resetExternalSubtitles() {
    cancelExternalSubtitleTasks()
    externalSubtitles.removeAll()
    externalSubtitleOrder.removeAll()
    activeExternalPrimaryId = nil
    activeSecondarySubtitleId = nil
    embeddedDecoderServingSecondary = false
  }

  func cancelExternalSubtitleTasks() {
    for task in externalSubtitleTasks.values {
      task.cancel()
    }
    externalSubtitleTasks.removeAll()
    externalSubtitleTaskTokens.removeAll()
  }

  /// Loads and parses an external sidecar subtitle track over an isolated HTTP(S) `URLSession`
  /// (`StreamHttp.makeSubtitleSession`, streamed with a 4 MiB ceiling) or validated local `file://` URI,
  /// offloading parsing off `@MainActor` (`#308`, `#32`, `#285`).
  func addExternalSubtitle(_ descriptor: ExternalSubtitleDescriptor) {
    let serial = activeLoadSerial
    guard serial > 0 else { return }
    let cleanId = descriptor.id.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanUri = descriptor.uri.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleanId.isEmpty, let url = URL(string: cleanUri), let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https" || scheme == "file"
    else {
      return
    }

    var normalized = descriptor
    normalized.id = cleanId
    normalized.uri = cleanUri
    let allowLegacyTls = currentLoadOptions?.allowLegacyTls ?? false

    externalSubtitleTasks[cleanId]?.cancel()
    externalSubtitleTaskSeq &+= 1
    let taskToken = externalSubtitleTaskSeq
    externalSubtitleTaskTokens[cleanId] = taskToken
    externalSubtitleTasks[cleanId] = Task { @MainActor [weak self] in
      defer {
        if let self, self.externalSubtitleTaskTokens[cleanId] == taskToken {
          self.externalSubtitleTasks.removeValue(forKey: cleanId)
          self.externalSubtitleTaskTokens.removeValue(forKey: cleanId)
        }
      }
      let data: Data?
      if scheme == "file" {
        data = await Self.readValidatedLocalSubtitle(url: url)
      } else {
        data = await Self.fetchIsolatedHttpSubtitle(
          url: url,
          headers: normalized.headers,
          allowLegacyTls: allowLegacyTls
        )
      }
      guard !Task.isCancelled,
            let data,
            !data.isEmpty,
            let currentSerial = self?.activeLoadSerial,
            currentSerial == serial,
            let currentToken = self?.externalSubtitleTaskTokens[cleanId],
            currentToken == taskToken
      else {
        return
      }
      let parseHint = normalized.mimeType ?? normalized.uri
      let parsed = await Task.detached(priority: .utility) {
        ExternalSubtitleParser.parse(
          data: data,
          hint: parseHint,
          maxBytes: ExternalSubtitleParser.maxBytes
        )
      }.value
      guard let self,
            !Task.isCancelled,
            self.activeLoadSerial == serial,
            self.externalSubtitleTaskTokens[cleanId] == taskToken,
            !parsed.cues.isEmpty
      else {
        return
      }

      let label = Self.resolveExternalLabel(for: normalized, url: url)
      let rawLang = normalizeTrackLanguage(normalized.language)
      let lang = (canonicalTrackLanguage(rawLang) != nil ? rawLang : nil) ?? extractTrackLanguageFromLabel(label)
      let info = TrackInfoOut(
        id: cleanId,
        language: lang,
        label: label,
        codec: parsed.format.rawValue,
        external: true
      )
      if self.externalSubtitles[cleanId] == nil {
        self.externalSubtitleOrder.append(cleanId)
      }
      self.externalSubtitles[cleanId] = LoadedExternalSubtitle(
        descriptor: normalized,
        cues: parsed.cues,
        trackInfo: info
      )
      self.emitCurrentTracksSnapshot()
      if let target = self.engine {
        self.refreshAllSubtitles(from: target)
      }
    }
  }

  /// Selects a loaded external subtitle track as primary, clearing embedded primary rendering (`#32`).
  func selectExternalSubtitleTrack(_ id: String?) {
    let clean = id?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let clean, !clean.isEmpty else {
      activeExternalPrimaryId = nil
      emitCurrentTracksSnapshot()
      if let target = engine {
        refreshAllSubtitles(from: target)
      }
      return
    }
    activeExternalPrimaryId = clean
    desiredSubtitleStreamId = nil
    currentLoadOptions?.initialSubtitleTrackId = nil
    currentLoadOptions?.subtitlesDisabled = true
    if activeSecondarySubtitleId == clean {
      activeSecondarySubtitleId = nil
    }
    // Keep embedded decoder active ONLY if an embedded track is currently serving as secondary.
    if let secId = activeSecondarySubtitleId, let secStreamId = parseSubtitleTrackStreamId(secId) {
      embeddedDecoderServingSecondary = true
      engine?.selectSubtitleTrack(index: secStreamId)
    } else {
      embeddedDecoderServingSecondary = false
      engine?.clearSubtitle()
    }
    emitCurrentTracksSnapshot()
    if let target = engine {
      refreshAllSubtitles(from: target)
    }
  }

  /// Selects a secondary subtitle track (external or embedded) rendered in top-center (`#402`).
  /// Enforces `secondary != primary` and rejects selecting a second embedded track while an embedded
  /// primary track is active (since `AetherEngine` natively decodes one embedded subtitle stream at a time).
  func selectSecondarySubtitleTrack(_ id: String?) {
    guard let raw = id?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      let wasEmbeddedSecondary = embeddedDecoderServingSecondary
      activeSecondarySubtitleId = nil
      embeddedDecoderServingSecondary = false
      if wasEmbeddedSecondary {
        engine?.clearSubtitle()
      }
      emitCurrentTracksSnapshot()
      if let target = engine {
        refreshAllSubtitles(from: target)
      }
      return
    }

    let currentPrimary = currentPrimarySubtitleId()
    guard raw != currentPrimary else { return }

    let secStreamId = parseSubtitleTrackStreamId(raw)
    let hasEmbeddedPrimary = currentPrimary.flatMap(parseSubtitleTrackStreamId) != nil
    if secStreamId != nil && hasEmbeddedPrimary {
      return
    }

    let previousWasEmbeddedSecondary = embeddedDecoderServingSecondary
    activeSecondarySubtitleId = raw

    if let secStreamId {
      embeddedDecoderServingSecondary = true
      engine?.selectSubtitleTrack(index: secStreamId)
    } else {
      embeddedDecoderServingSecondary = false
      if previousWasEmbeddedSecondary {
        engine?.clearSubtitle()
      }
    }

    emitCurrentTracksSnapshot()
    if let target = engine {
      refreshAllSubtitles(from: target)
    }
  }

  func currentPrimarySubtitleId() -> String? {
    if let externalPrimary = activeExternalPrimaryId {
      return externalPrimary
    }
    if embeddedDecoderServingSecondary {
      return nil
    }
    guard let target = engine, target.isSubtitleActive else {
      return desiredSubtitleStreamId.map(formatSubtitleTrackId)
    }
    return target.activeSubtitleTrackIndex.map(formatSubtitleTrackId)
  }

  func emitCurrentTracksSnapshot() {
    guard let target = engine, engineLoadSerial > 0 else { return }
    emitTracksObservation(
      audioTracks: target.audioTracks,
      subtitleTracks: target.subtitleTracks,
      activeAudioIndex: target.activeAudioTrackIndex,
      isSubtitleActive: target.isSubtitleActive,
      activeSubtitleIndex: target.activeSubtitleTrackIndex,
      serial: engineLoadSerial
    )
  }

  private nonisolated static func fetchIsolatedHttpSubtitle(
    url: URL,
    headers: [String: String],
    allowLegacyTls: Bool
  ) async -> Data? {
    let maxBytes = ExternalSubtitleParser.maxBytes
    let session = StreamHttp.makeSubtitleSession(headers: headers, allowLegacyTls: allowLegacyTls)
    defer { session.invalidateAndCancel() }
    let request = StreamHttp.makeSubtitleRequest(url: url, headers: headers)
    do {
      let (bytes, response) = try await session.bytes(for: request)
      guard !Task.isCancelled,
            let http = response as? HTTPURLResponse,
            (200...299).contains(http.statusCode)
      else {
        bytes.task.cancel()
        throw SubtitleFetchError.invalidResponse
      }
      if response.expectedContentLength > Int64(maxBytes) {
        bytes.task.cancel()
        throw SubtitleFetchError.exceedsMaxBytes
      }
      var data = Data()
      if response.expectedContentLength > 0 {
        data.reserveCapacity(min(Int(response.expectedContentLength), maxBytes))
      }
      var chunk: [UInt8] = []
      chunk.reserveCapacity(16_384)
      for try await byte in bytes {
        if Task.isCancelled {
          bytes.task.cancel()
          return nil
        }
        chunk.append(byte)
        if data.count + chunk.count > maxBytes {
          bytes.task.cancel()
          throw SubtitleFetchError.exceedsMaxBytes
        }
        if chunk.count >= 16_384 {
          data.append(contentsOf: chunk)
          chunk.removeAll(keepingCapacity: true)
        }
      }
      if !chunk.isEmpty {
        data.append(contentsOf: chunk)
      }
      return data
    } catch {
      return nil
    }
  }

  private nonisolated static func readValidatedLocalSubtitle(url: URL) async -> Data? {
    await Task.detached(priority: .utility) {
      ExternalSubtitleParser.readValidatedLocalSubtitle(url: url, maxBytes: ExternalSubtitleParser.maxBytes)
    }.value
  }

  private static func resolveExternalLabel(for descriptor: ExternalSubtitleDescriptor, url: URL) -> String {
    if let label = descriptor.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
      return label
    }
    let name = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
    return name.isEmpty ? descriptor.id : name
  }
}

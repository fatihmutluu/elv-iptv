import AetherEngine
import Foundation

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
      if activeExternalPrimaryId != nil,
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
  }

  func cancelExternalSubtitleTasks() {
    for task in externalSubtitleTasks.values {
      task.cancel()
    }
    externalSubtitleTasks.removeAll()
  }

  /// Loads and parses an external sidecar subtitle track over an isolated HTTP(S) `URLSession`
  /// (`StreamHttp.makeSubtitleSession`) or validated local `file://` URI (`<= 4 MiB`, `#308`, `#32`).
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
    externalSubtitleTasks[cleanId] = Task { @MainActor [weak self] in
      defer {
        if let self {
          self.externalSubtitleTasks.removeValue(forKey: cleanId)
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
      guard let self, !Task.isCancelled, self.activeLoadSerial == serial, let data, !data.isEmpty else {
        return
      }
      let parsed = ExternalSubtitleParser.parse(
        data: data,
        hint: normalized.mimeType ?? normalized.uri,
        maxBytes: ExternalSubtitleParser.maxBytes
      )
      guard !parsed.cues.isEmpty else { return }

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
      engine?.selectSubtitleTrack(index: secStreamId)
    } else {
      engine?.clearSubtitle()
    }
    emitCurrentTracksSnapshot()
    if let target = engine {
      refreshAllSubtitles(from: target)
    }
  }

  /// Selects a secondary subtitle track (external or embedded) rendered in top-center, enforcing `secondary != primary` (`#402`).
  func selectSecondarySubtitleTrack(_ id: String?) {
    guard let raw = id?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      let wasEmbeddedSecondary = activeExternalPrimaryId != nil
        && activeSecondarySubtitleId.flatMap(parseSubtitleTrackStreamId) != nil
      activeSecondarySubtitleId = nil
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

    let previousWasEmbeddedSecondary = activeExternalPrimaryId != nil
      && activeSecondarySubtitleId.flatMap(parseSubtitleTrackStreamId) != nil
    activeSecondarySubtitleId = raw

    if activeExternalPrimaryId != nil {
      if let secStreamId = parseSubtitleTrackStreamId(raw) {
        engine?.selectSubtitleTrack(index: secStreamId)
      } else if previousWasEmbeddedSecondary {
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
    let session = StreamHttp.makeSubtitleSession(headers: headers, allowLegacyTls: allowLegacyTls)
    defer { session.finishTasksAndInvalidate() }
    let request = StreamHttp.makeSubtitleRequest(url: url, headers: headers)
    do {
      let (data, response) = try await session.data(for: request)
      guard !Task.isCancelled,
            let http = response as? HTTPURLResponse,
            (200...299).contains(http.statusCode)
      else {
        return nil
      }
      if data.count > ExternalSubtitleParser.maxBytes {
        return Data(data.prefix(ExternalSubtitleParser.maxBytes))
      }
      return data
    } catch {
      return nil
    }
  }

  private nonisolated static func readValidatedLocalSubtitle(url: URL) async -> Data? {
    await Task.detached(priority: .utility) {
      let standardized = url.standardizedFileURL
      guard standardized.isFileURL else { return nil }
      do {
        let values = try standardized.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { return nil }
        if let size = values.fileSize, size <= 0 || size > ExternalSubtitleParser.maxBytes {
          return nil
        }
        let handle = try FileHandle(forReadingFrom: standardized)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: ExternalSubtitleParser.maxBytes + 1) ?? Data()
        guard !data.isEmpty, data.count <= ExternalSubtitleParser.maxBytes else { return nil }
        return data
      } catch {
        return nil
      }
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

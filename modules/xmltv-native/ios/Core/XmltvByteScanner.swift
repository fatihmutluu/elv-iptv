import Foundation

public struct ScannedXmltvChannel: Sendable, Equatable {
  public let id: String
  public var names: [String]
  public var icon: String?
  public var lcn: String?

  public init(id: String, names: [String], icon: String? = nil, lcn: String? = nil) {
    self.id = id
    self.names = names
    self.icon = icon
    self.lcn = lcn
  }
}

public struct StagedProgrammeRow: Sendable, Equatable {
  public let sourceId: String
  public let guideId: String
  public let start: Int64
  public let stop: Int64
  public let title: String
  public let subTitle: String?
  public let description: String?
  public let categoriesJson: String?
  public let episodeNum: String?
  public let icon: String?
  public let runId: Int64
  public let genre: String?
  public let flags: Int32
  public let ratingSystem: String?
  public let ratingValue: String?
  public let titleFold: String
  public let descriptionFold: String

  public init(
    sourceId: String,
    guideId: String,
    start: Int64,
    stop: Int64,
    title: String,
    subTitle: String?,
    description: String?,
    categoriesJson: String?,
    episodeNum: String?,
    icon: String?,
    runId: Int64,
    genre: String?,
    flags: Int32,
    ratingSystem: String?,
    ratingValue: String?,
    titleFold: String,
    descriptionFold: String
  ) {
    self.sourceId = sourceId
    self.guideId = guideId
    self.start = start
    self.stop = stop
    self.title = title
    self.subTitle = subTitle
    self.description = description
    self.categoriesJson = categoriesJson
    self.episodeNum = episodeNum
    self.icon = icon
    self.runId = runId
    self.genre = genre
    self.flags = flags
    self.ratingSystem = ratingSystem
    self.ratingValue = ratingValue
    self.titleFold = titleFold
    self.descriptionFold = descriptionFold
  }

  public func withStop(_ newStop: Int64) -> StagedProgrammeRow {
    StagedProgrammeRow(
      sourceId: sourceId, guideId: guideId, start: start, stop: newStop,
      title: title, subTitle: subTitle, description: description,
      categoriesJson: categoriesJson, episodeNum: episodeNum, icon: icon,
      runId: runId, genre: genre, flags: flags,
      ratingSystem: ratingSystem, ratingValue: ratingValue,
      titleFold: titleFold, descriptionFold: descriptionFold
    )
  }
}

public struct XmltvScanSummary: Sendable, Equatable {
  public let channels: [ScannedXmltvChannel]
  public let stagedCounts: [String: Int]
  public let seenProgrammes: Int
  public let stagedProgrammes: Int
  public let warnings: Int
  public let warningCodes: [String]
}

/// Low-allocation streaming UTF-8 byte-array XMLTV scanner matching Android & `@elv/sources` semantics.
public final class XmltvByteScanner {
  public static let openEndMs: Int64 = 30 * 60_000
  public static let maxElementBytes: Int = 1 << 20
  public static let maxWarnings: Int = 100
  private static let tarHeaderBytes: Int = 512
  private static let tarUstarOffset: Int = 257
  private static let maxOpenStack: Int = 64
  private static let lookback: Int = 8

  private static let bProgramme = Array("programme".utf8)
  private static let bChannel = Array("channel".utf8)
  private static let bDisplayName = Array("display-name".utf8)
  private static let bLcn = Array("lcn".utf8)
  private static let bIcon = Array("icon".utf8)
  private static let bTitle = Array("title".utf8)
  private static let bSubTitle = Array("sub-title".utf8)
  private static let bDesc = Array("desc".utf8)
  private static let bCategory = Array("category".utf8)
  private static let bEpisodeNum = Array("episode-num".utf8)
  private static let bRating = Array("rating".utf8)
  private static let bLive = Array("live".utf8)
  private static let bNew = Array("new".utf8)
  private static let bPremiere = Array("premiere".utf8)
  private static let bPreviouslyShown = Array("previously-shown".utf8)
  private static let bUstar = Array("ustar".utf8)

  private struct OpenProgramme {
    let channel: String
    let start: Int64
    let title: String
    let subTitle: String?
    let desc: String?
    let categories: [String]
    let episodeNum: String?
    let icon: String?
    let isLive: Bool
    let isNew: Bool
    let isPremiere: Bool
    let previouslyShown: Bool
    let ratingSystem: String?
    let ratingValue: String?
  }

  private let sourceId: String
  private let runId: Int64
  private let fromMs: Int64
  private let toMs: Int64
  private let defaultTimeZone: String?

  private var channelOrder: [String] = []
  private var channelsById: [String: ScannedXmltvChannel] = [:]
  private var openByChannel: [String: OpenProgramme] = [:]
  private var lastByChannel: [String: StagedProgrammeRow] = [:]
  private var stagedCounts: [String: Int] = [:]
  private var warningCodes: [String] = []
  private var warnings: Int = 0
  private var seenProgrammes: Int = 0
  private var stagedProgrammes: Int = 0

  private var buf: [UInt8] = []
  private var headerChecked = false
  private var openStarts = [Int](repeating: 0, count: maxOpenStack)
  private var openLens = [Int](repeating: 0, count: maxOpenStack)
  private var openDepth = 0

  public init(
    sourceId: String,
    runId: Int64,
    fromMs: Int64,
    toMs: Int64,
    defaultTimeZone: String? = nil
  ) {
    self.sourceId = sourceId
    self.runId = runId
    self.fromMs = fromMs
    self.toMs = toMs
    self.defaultTimeZone = defaultTimeZone
    self.buf.reserveCapacity(131_072)
  }

  public func feed(_ chunk: UnsafeBufferPointer<UInt8>, onRow: (StagedProgrammeRow) throws -> Void) throws {
    guard chunk.count > 0 else { return }
    buf.append(contentsOf: chunk)
    if !headerChecked && buf.count >= Self.tarHeaderBytes { stripBomAndTarHeader() }
    if headerChecked { try processBuffer(finalPass: false, onRow: onRow) }
  }

  public func finish(onRow: (StagedProgrammeRow) throws -> Void) throws -> XmltvScanSummary {
    if !headerChecked { stripBomAndTarHeader() }
    try processBuffer(finalPass: true, onRow: onRow)
    for p in openByChannel.values {
      try emitClamped(toStageRow(p, stop: p.start + Self.openEndMs), onRow: onRow)
    }
    openByChannel.removeAll()
    let channels = channelOrder.compactMap { channelsById[$0] }
    return XmltvScanSummary(
      channels: channels,
      stagedCounts: stagedCounts,
      seenProgrammes: seenProgrammes,
      stagedProgrammes: stagedProgrammes,
      warnings: warnings,
      warningCodes: warningCodes
    )
  }

  private func stripBomAndTarHeader() {
    headerChecked = true
    if buf.count >= Self.tarHeaderBytes && XmltvByteTokens.matchesAt(buf, at: Self.tarUstarOffset, needle: Self.bUstar) {
      buf.removeFirst(Self.tarHeaderBytes)
    }
    if buf.count >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF {
      buf.removeFirst(3)
    }
  }

  private func processBuffer(finalPass: Bool, onRow: (StagedProgrammeRow) throws -> Void) throws {
    var pos = 0
    let len = buf.count
    while pos < len {
      let lt = XmltvByteTokens.indexOfByte(buf, from: pos, to: len, target: 60)
      if lt < 0 { pos = len; break }
      pos = lt
      if lt + 1 >= len { if finalPass { pos = len }; break }
      let b1 = buf[lt + 1]
      if !XmltvByteTokens.isMarkupStart(b1) { pos = lt + 1; continue }
      if b1 == 47 {
        let gt = XmltvByteTokens.indexOfByte(buf, from: lt + 2, to: len, target: 62)
        if gt < 0 { if finalPass { pos = len }; break }
        pos = gt + 1; continue
      }
      if b1 == 33 || b1 == 63 {
        let skip = XmltvByteTokens.skipMarkup(buf, lt: lt, limit: len)
        if skip < 0 {
          if len - lt > Self.maxElementBytes { recordWarning("element-too-long"); pos = lt + 1; continue }
          if finalPass { pos = len }
          break
        }
        pos = skip; continue
      }
      let progMatch = XmltvByteTokens.matchTagName(buf, at: lt + 1, limit: len, expected: Self.bProgramme)
      if progMatch < 0 { if finalPass { pos = len }; break }
      if progMatch == 1 {
        let next = try scanElement(lt: lt, isProgramme: true, finalPass: finalPass, onRow: onRow)
        if next < 0 { break }
        pos = next; continue
      }
      let chanMatch = XmltvByteTokens.matchTagName(buf, at: lt + 1, limit: len, expected: Self.bChannel)
      if chanMatch < 0 { if finalPass { pos = len }; break }
      if chanMatch == 1 {
        let next = try scanElement(lt: lt, isProgramme: false, finalPass: finalPass, onRow: onRow)
        if next < 0 { break }
        pos = next; continue
      }
      let tagEnd = XmltvByteTokens.findTagEnd(buf, lt: lt, limit: len)
      if tagEnd == -1 {
        if len - lt > Self.maxElementBytes { recordWarning("element-too-long"); pos = lt + 1; continue }
        if finalPass { pos = len }
        break
      }
      pos = tagEnd == -2 ? lt + 1 : tagEnd
    }
    if pos > 0 {
      if pos >= buf.count { buf.removeAll(keepingCapacity: true) }
      else { buf.removeFirst(pos) }
    }
  }

  private func scanElement(
    lt: Int,
    isProgramme: Bool,
    finalPass: Bool,
    onRow: (StagedProgrammeRow) throws -> Void
  ) throws -> Int {
    let kind = isProgramme ? "programme" : "channel"
    let nameBytes = isProgramme ? Self.bProgramme : Self.bChannel
    let len = buf.count
    let tagEnd = XmltvByteTokens.findTagEnd(buf, lt: lt, limit: len)
    if tagEnd == -1 {
      if len - lt > Self.maxElementBytes { recordWarning("element-too-long"); return lt + 1 }
      if finalPass { recordWarning("\(kind)-truncated"); return len }
      return -1
    }
    if tagEnd == -2 { recordWarning("\(kind)-malformed"); return lt + 1 }
    let selfClosing = tagEnd >= 2 && buf[tagEnd - 2] == 47
    var bodyEnd = tagEnd
    var end = tagEnd
    if !selfClosing {
      let close = XmltvByteTokens.findCloseTag(buf, from: tagEnd, limit: len, name: nameBytes, allowIncomplete: true)
      if close == -1 {
        if len - lt > Self.maxElementBytes { recordWarning("element-too-long"); return lt + 1 }
        if finalPass { recordWarning("\(kind)-truncated"); return len }
        return -1
      }
      if close == -2 { recordWarning("\(kind)-unclosed"); return lt + 1 }
      let gt = XmltvByteTokens.indexOfByte(buf, from: close, to: len, target: 62)
      if gt < 0 {
        if finalPass { recordWarning("\(kind)-truncated"); return len }
        return -1
      }
      bodyEnd = close
      end = gt + 1
    }
    if end - lt > Self.maxElementBytes { recordWarning("element-too-long"); return end }
    let attrStart = XmltvByteTokens.nameEnd(buf, from: lt + 1, limit: tagEnd)
    let attrEnd = selfClosing ? tagEnd - 2 : tagEnd - 1
    if isProgramme {
      try parseProgramme(attrStart: attrStart, attrEnd: attrEnd, bodyStart: tagEnd, bodyEnd: bodyEnd, onRow: onRow)
    } else {
      parseChannel(attrStart: attrStart, attrEnd: attrEnd, bodyStart: tagEnd, bodyEnd: bodyEnd)
    }
    return end
  }

  private func parseChannel(attrStart: Int, attrEnd: Int, bodyStart: Int, bodyEnd: Int) {
    let id = XmltvByteTokens.readAttr(buf, from: attrStart, to: attrEnd, target: "id")?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let id, !id.isEmpty else { recordWarning("channel-missing-id"); return }
    var names: [String] = []
    var icon: String?
    var lcn: String?
    openDepth = 0
    var i = bodyStart
    while i < bodyEnd {
      let lt = XmltvByteTokens.indexOfByte(buf, from: i, to: bodyEnd, target: 60)
      if lt < 0 || lt + 1 >= bodyEnd { break }
      let b1 = buf[lt + 1]
      if !XmltvByteTokens.isMarkupStart(b1) { i = lt + 1; continue }
      if b1 == 47 { closeUnknown(buf, at: lt + 2, limit: bodyEnd); i = lt + 2; continue }
      if b1 == 33 || b1 == 63 {
        let skip = XmltvByteTokens.skipMarkup(buf, lt: lt, limit: bodyEnd)
        if skip < 0 { recordWarning("channel-malformed"); return }
        i = skip; continue
      }
      let tagEnd = XmltvByteTokens.findTagEnd(buf, lt: lt, limit: bodyEnd)
      if tagEnd < 0 { recordWarning("channel-malformed"); return }
      let ns = lt + 1
      let nLen = XmltvByteTokens.nameEnd(buf, from: ns, limit: tagEnd) - ns
      let selfClosing = buf[tagEnd - 2] == 47
      if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bIcon) {
        if openDepth == 0 && icon == nil, let src = XmltvByteTokens.readAttr(buf, from: ns + nLen, to: tagEnd - 1, target: "src") {
          icon = XmltvTextHelpers.sanitizeArtworkUrl(src)
        }
        if !selfClosing { pushOpen(ns, nLen) }
        i = tagEnd; continue
      }
      let isDisplayName = XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bDisplayName)
      let isLcn = !isDisplayName && XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bLcn)
      if !isDisplayName && !isLcn {
        if !selfClosing { pushOpen(ns, nLen) }
        i = tagEnd; continue
      }
      if selfClosing { i = tagEnd; continue }
      let close = XmltvByteTokens.findCloseTag(buf, from: tagEnd, limit: bodyEnd, name: isDisplayName ? Self.bDisplayName : Self.bLcn, allowIncomplete: false)
      if close < 0 { recordWarning("channel-malformed"); return }
      let gt = XmltvByteTokens.indexOfByte(buf, from: close, to: bodyEnd, target: 62)
      if gt < 0 { recordWarning("channel-malformed"); return }
      i = gt + 1
      let text = XmltvByteTokens.readElementText(buf, from: tagEnd, to: close)
      if !text.isEmpty {
        if isDisplayName { names.append(text) }
        else if openDepth == 0 && lcn == nil { lcn = text }
      }
    }
    if var existing = channelsById[id] {
      for n in names where !existing.names.contains(n) { existing.names.append(n) }
      if (existing.icon ?? "").isEmpty, let icon, !icon.isEmpty { existing.icon = icon }
      if (existing.lcn ?? "").isEmpty, let lcn, !lcn.isEmpty { existing.lcn = lcn }
      channelsById[id] = existing
    } else {
      var deduped: [String] = []
      for n in names where !deduped.contains(n) { deduped.append(n) }
      channelOrder.append(id)
      channelsById[id] = ScannedXmltvChannel(id: id, names: deduped, icon: icon, lcn: lcn)
    }
  }

  private func parseProgramme(
    attrStart: Int,
    attrEnd: Int,
    bodyStart: Int,
    bodyEnd: Int,
    onRow: (StagedProgrammeRow) throws -> Void
  ) throws {
    var rawChannel: String?
    var startText: String?
    var stopText: String?
    XmltvByteTokens.readAttrs(buf, from: attrStart, to: attrEnd) { name, value in
      if name == "channel" { rawChannel = value }
      else if name == "start" { startText = value }
      else if name == "stop" { stopText = value }
    }
    let channel = rawChannel?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let channel, !channel.isEmpty else { recordWarning("programme-missing-channel"); return }
    guard let startText else { recordWarning("programme-missing-start"); return }
    let start = XmltvTextHelpers.parseXmltvTime(startText, defaultTimeZone: defaultTimeZone)
    let stop = stopText.flatMap { XmltvTextHelpers.parseXmltvTime($0, defaultTimeZone: defaultTimeZone) }
    guard let start,
          start >= XmltvTextHelpers.minValidXmltvEpochMs,
          (stopText == nil || stop != nil),
          (stop == nil || (stop! >= XmltvTextHelpers.minValidXmltvEpochMs && stop! > start)) else {
      recordWarning("programme-bad-time")
      return
    }
    if start >= toMs { return }
    if let stop { if stop <= fromMs { return } } else if start < fromMs { return }

    var title = ""
    var hasTitle = false
    var subTitle: String?
    var desc: String?
    var categories: [String] = []
    var episodeNum: String?
    var episodeRank = -1
    var icon: String?
    var ratingSystem: String?
    var ratingValue: String?
    var tagLive = false
    var tagNew = false
    var titleBadgeLive = false
    var titleBadgeNew = false
    var isPremiere = false
    var previouslyShown = false

    openDepth = 0
    var i = bodyStart
    while i < bodyEnd {
      let lt = XmltvByteTokens.indexOfByte(buf, from: i, to: bodyEnd, target: 60)
      if lt < 0 || lt + 1 >= bodyEnd { break }
      let b1 = buf[lt + 1]
      if !XmltvByteTokens.isMarkupStart(b1) { i = lt + 1; continue }
      if b1 == 47 { closeUnknown(buf, at: lt + 2, limit: bodyEnd); i = lt + 2; continue }
      if b1 == 33 || b1 == 63 {
        let skip = XmltvByteTokens.skipMarkup(buf, lt: lt, limit: bodyEnd)
        if skip < 0 { recordWarning("programme-malformed"); return }
        i = skip; continue
      }
      let tagEnd = XmltvByteTokens.findTagEnd(buf, lt: lt, limit: bodyEnd)
      if tagEnd < 0 { recordWarning("programme-malformed"); return }
      let ns = lt + 1
      let nLen = XmltvByteTokens.nameEnd(buf, from: ns, limit: tagEnd) - ns
      let selfClosing = buf[tagEnd - 2] == 47

      if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bIcon) {
        if openDepth == 0 && icon == nil, let src = XmltvByteTokens.readAttr(buf, from: ns + nLen, to: tagEnd - 1, target: "src") {
          icon = XmltvTextHelpers.sanitizeArtworkUrl(src)
        }
        if !selfClosing { pushOpen(ns, nLen) }
        i = tagEnd; continue
      }
      if openDepth == 0 {
        if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bLive) { tagLive = true; if !selfClosing { pushOpen(ns, nLen) }; i = tagEnd; continue }
        if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bNew) { tagNew = true; if !selfClosing { pushOpen(ns, nLen) }; i = tagEnd; continue }
        if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bPremiere) { isPremiere = true; if !selfClosing { pushOpen(ns, nLen) }; i = tagEnd; continue }
        if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bPreviouslyShown) { previouslyShown = true; if !selfClosing { pushOpen(ns, nLen) }; i = tagEnd; continue }
      }

      enum Wanted { case title, desc, category, episodeNum, subTitle, rating }
      let wanted: Wanted?
      let closeName: [UInt8]
      if openDepth == 0 {
        if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bTitle) { wanted = .title; closeName = Self.bTitle }
        else if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bDesc) { wanted = .desc; closeName = Self.bDesc }
        else if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bCategory) { wanted = .category; closeName = Self.bCategory }
        else if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bEpisodeNum) { wanted = .episodeNum; closeName = Self.bEpisodeNum }
        else if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bSubTitle) { wanted = .subTitle; closeName = Self.bSubTitle }
        else if XmltvByteTokens.isTag(buf, at: ns, len: nLen, expected: Self.bRating) { wanted = .rating; closeName = Self.bRating }
        else { wanted = nil; closeName = [] }
      } else {
        wanted = nil
        closeName = []
      }
      guard let wanted else { if !selfClosing { pushOpen(ns, nLen) }; i = tagEnd; continue }
      if selfClosing { i = tagEnd; continue }
      let close = XmltvByteTokens.findCloseTag(buf, from: tagEnd, limit: bodyEnd, name: closeName, allowIncomplete: false)
      if close < 0 { recordWarning("programme-malformed"); return }
      let gt = XmltvByteTokens.indexOfByte(buf, from: close, to: bodyEnd, target: 62)
      if gt < 0 { recordWarning("programme-malformed"); return }
      i = gt + 1

      switch wanted {
      case .title:
        if !hasTitle {
          let cleaned = XmltvTextHelpers.cleanTitleAndFlags(XmltvByteTokens.readElementText(buf, from: tagEnd, to: close))
          title = cleaned.title; titleBadgeLive = cleaned.isLive; titleBadgeNew = cleaned.isNew; hasTitle = true
        }
      case .category:
        let t = XmltvByteTokens.readElementText(buf, from: tagEnd, to: close)
        if !t.isEmpty { categories.append(t) }
      case .desc:
        if desc == nil {
          let t = XmltvByteTokens.readElementText(buf, from: tagEnd, to: close)
          if !t.isEmpty { desc = t }
        }
      case .subTitle:
        if subTitle == nil {
          let t = XmltvTextHelpers.stripInlineHtml(XmltvByteTokens.readElementText(buf, from: tagEnd, to: close))
          if !t.isEmpty { subTitle = t }
        }
      case .episodeNum:
        let sys = XmltvByteTokens.readAttr(buf, from: ns + nLen, to: tagEnd - 1, target: "system")
        let rank = XmltvTextHelpers.episodeNumRank(sys)
        if rank > episodeRank {
          let t = XmltvByteTokens.readElementText(buf, from: tagEnd, to: close)
          if !t.isEmpty && (rank != 3 || XmltvTextHelpers.isValidXmltvNs(t)) {
            episodeNum = t; episodeRank = rank
          }
        }
      case .rating:
        if openDepth == 0 && ratingValue == nil {
          let sys = XmltvByteTokens.readAttr(buf, from: ns + nLen, to: tagEnd - 1, target: "system")?.trimmingCharacters(in: .whitespacesAndNewlines)
          if let val = XmltvByteTokens.extractRatingValue(buf, from: tagEnd, to: close), !val.isEmpty {
            ratingValue = val
            if let sys, !sys.isEmpty { ratingSystem = sys }
          }
        }
      }
    }

    if episodeNum == nil, let desc { episodeNum = XmltvTextHelpers.extractDescEpisodeNum(desc) }
    seenProgrammes += 1
    try ingestProgramme(
      OpenProgramme(
        channel: channel, start: start, title: title, subTitle: subTitle, desc: desc,
        categories: categories, episodeNum: episodeNum, icon: icon,
        isLive: tagLive || titleBadgeLive, isNew: tagNew || titleBadgeNew,
        isPremiere: isPremiere, previouslyShown: previouslyShown,
        ratingSystem: ratingSystem, ratingValue: ratingValue
      ),
      stop: stop,
      onRow: onRow
    )
  }

  private func ingestProgramme(
    _ p: OpenProgramme,
    stop: Int64?,
    onRow: (StagedProgrammeRow) throws -> Void
  ) throws {
    if let prev = openByChannel[p.channel] {
      if p.start > prev.start {
        openByChannel.removeValue(forKey: p.channel)
        try emitClamped(toStageRow(prev, stop: p.start), onRow: onRow)
      } else if p.start == prev.start {
        openByChannel.removeValue(forKey: p.channel)
      } else {
        let clampedStop = stop.map { min($0, prev.start) } ?? prev.start
        try emitClamped(toStageRow(p, stop: clampedStop), onRow: onRow)
        return
      }
    }
    if let stop { try emitClamped(toStageRow(p, stop: stop), onRow: onRow) }
    else { openByChannel[p.channel] = p }
  }

  private func toStageRow(_ p: OpenProgramme, stop: Int64) -> StagedProgrammeRow {
    let flags: Int32 = (p.isLive || p.isNew || p.isPremiere || p.previouslyShown)
      ? XmltvTextHelpers.encodeProgrammeFlags(
          isLive: p.isLive, isNew: p.isNew, isPremiere: p.isPremiere, previouslyShown: p.previouslyShown
        )
      : 0
    return StagedProgrammeRow(
      sourceId: sourceId, guideId: p.channel, start: p.start, stop: stop,
      title: p.title, subTitle: p.subTitle, description: p.desc,
      categoriesJson: p.categories.isEmpty ? nil : XmltvTextHelpers.encodeJsonStringArray(p.categories),
      episodeNum: p.episodeNum, icon: p.icon, runId: runId,
      genre: XmltvTextHelpers.normalizeEpgGenre(p.categories), flags: flags,
      ratingSystem: p.ratingSystem, ratingValue: p.ratingValue,
      titleFold: XmltvTextHelpers.foldText(p.title),
      descriptionFold: p.desc.map { XmltvTextHelpers.foldText($0) } ?? ""
    )
  }

  private func emitClamped(
    _ row: StagedProgrammeRow,
    onRow: (StagedProgrammeRow) throws -> Void
  ) throws {
    guard let prev = lastByChannel[row.guideId] else {
      try onRow(row)
      lastByChannel[row.guideId] = row
      stagedCounts[row.guideId, default: 0] += 1
      stagedProgrammes += 1
      return
    }
    if row.start == prev.start {
      try onRow(row)
      lastByChannel[row.guideId] = row
      return
    }
    if row.start > prev.start {
      if prev.stop > row.start { try onRow(prev.withStop(row.start)) }
      try onRow(row)
      lastByChannel[row.guideId] = row
      stagedCounts[row.guideId, default: 0] += 1
      stagedProgrammes += 1
      return
    }
    let clamped = row.stop > prev.start ? row.withStop(prev.start) : row
    if clamped.stop > clamped.start {
      try onRow(clamped)
      stagedCounts[row.guideId, default: 0] += 1
      stagedProgrammes += 1
    }
  }

  private func pushOpen(_ start: Int, _ len: Int) {
    guard openDepth < Self.maxOpenStack else { return }
    openStarts[openDepth] = start
    openLens[openDepth] = len
    openDepth += 1
  }

  private func closeUnknown(_ bytes: [UInt8], at: Int, limit: Int) {
    let len = XmltvByteTokens.nameEnd(bytes, from: at, limit: limit) - at
    let floor = max(0, openDepth - Self.lookback)
    var k = openDepth - 1
    while k >= floor {
      if openLens[k] == len {
        let start = openStarts[k]
        var same = true
        for j in 0..<len where bytes[start + j] != bytes[at + j] { same = false; break }
        if same { openDepth = k; return }
      }
      k -= 1
    }
  }

  private func recordWarning(_ code: String) {
    warnings += 1
    if warningCodes.count < Self.maxWarnings { warningCodes.append(code) }
  }
}

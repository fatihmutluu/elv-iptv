import Foundation
import SQLite3
import Testing
import zlib
@testable import ElvXmltvCore

private func gzipCompress(_ input: [UInt8]) throws -> [UInt8] {
  var stream = z_stream()
  let rc = deflateInit2_(
    &stream,
    Z_DEFAULT_COMPRESSION,
    Z_DEFLATED,
    15 + 16,
    8,
    Z_DEFAULT_STRATEGY,
    ZLIB_VERSION,
    Int32(MemoryLayout<z_stream>.size)
  )
  #expect(rc == Z_OK)
  defer { deflateEnd(&stream) }

  var output: [UInt8] = []
  var chunk = [UInt8](repeating: 0, count: 4096)
  input.withUnsafeBufferPointer { inPtr in
    stream.next_in = UnsafeMutablePointer<Bytef>(mutating: inPtr.baseAddress)
    stream.avail_in = uInt(inPtr.count)
    while true {
      var produced = 0
      var defRc: Int32 = Z_OK
      chunk.withUnsafeMutableBufferPointer { outPtr in
        stream.next_out = outPtr.baseAddress
        stream.avail_out = uInt(outPtr.count)
        defRc = deflate(&stream, Z_FINISH)
        produced = outPtr.count - Int(stream.avail_out)
      }
      if produced > 0 {
        output.append(contentsOf: chunk[0..<produced])
      }
      if defRc == Z_STREAM_END { break }
    }
  }
  return output
}

@Suite("ElvXmltvCore Scanner & SQLite Writer")
struct XmltvByteScannerTests {
  @Test("parses channels, programmes, entities, ratings, flags, and episode numbers")
  func parsesXmltvFields() throws {
    let xml = """
    <?xml version="1.0" encoding="UTF-8"?>
    <tv>
      <channel id="ch1">
        <display-name>News &amp; Weather</display-name>
        <display-name>News HD</display-name>
        <icon src="https://cdn.example/news.png" />
        <lcn>101</lcn>
      </channel>
      <programme start="20261125120000 +0000" stop="20261125130000 +0000" channel="ch1">
        <title>&lt;b&gt;Breaking&lt;/b&gt; &quot;News&quot; &#38; &#x21;</title>
        <sub-title>&lt;i&gt;Midday&lt;/i&gt; Edition</sub-title>
        <desc>Top stories from İstanbul.</desc>
        <category>News</category>
        <episode-num system="onscreen">S02E05</episode-num>
        <episode-num system="xmltv_ns">1.4.</episode-num>
        <rating system="MPAA"><icon src="https://cdn.example/ignore.png" /><value>TV-PG</value></rating>
        <icon src="https://cdn.example/prog.png" />
        <live />
        <new />
        <premiere />
        <previously-shown />
      </programme>
    </tv>
    """
    let fromMs = try #require(XmltvTextHelpers.parseXmltvTime("20261125000000 +0000"))
    let toMs = try #require(XmltvTextHelpers.parseXmltvTime("20261126000000 +0000"))
    let scanner = XmltvByteScanner(sourceId: "src-1", runId: 42, fromMs: fromMs, toMs: toMs)
    var rows: [StagedProgrammeRow] = []

    let bytes = Array(xml.utf8)
    try bytes.withUnsafeBufferPointer { ptr in
      try scanner.feed(ptr) { rows.append($0) }
    }
    let summary = try scanner.finish { rows.append($0) }

    #expect(summary.channels.count == 1)
    #expect(summary.channels[0].id == "ch1")
    #expect(summary.channels[0].names == ["News & Weather", "News HD"])
    #expect(summary.channels[0].icon == "https://cdn.example/news.png")
    #expect(summary.channels[0].lcn == "101")
    #expect(summary.seenProgrammes == 1)
    #expect(summary.stagedProgrammes == 1)
    #expect(rows.count == 1)
    let row = rows[0]
    #expect(row.title == "Breaking \"News\" & !")
    #expect(row.subTitle == "Midday Edition")
    #expect(row.episodeNum == "1.4.")
    #expect(row.icon == "https://cdn.example/prog.png")
    #expect(row.genre == "news")
    #expect(row.flags == 15)
    #expect(row.ratingSystem == "MPAA")
    #expect(row.ratingValue == "TV-PG")
    #expect(row.titleFold == "breaking news")
    #expect(row.descriptionFold == "top stories from istanbul")
  }

  @Test("inflates streaming gzip chunks and stages directly into SQLite programmes_next")
  func gzipAndSqliteWriter() throws {
    let xml = """
    <tv>
      <channel id="c1"><display-name>Sports 1</display-name></channel>
      <programme start="20261125100000 +0000" stop="20261125113000 +0000" channel="c1">
        <title>Match 1</title>
        <category>Futbol</category>
      </programme>
      <programme start="20261125110000 +0000" channel="c1">
        <title>Open Show</title>
        <category>Sinema</category>
      </programme>
    </tv>
    """
    let gz = try gzipCompress(Array(xml.utf8))
    let fromMs = try #require(XmltvTextHelpers.parseXmltvTime("20261125000000 +0000"))
    let toMs = try #require(XmltvTextHelpers.parseXmltvTime("20261126000000 +0000"))

    let tmpDir = FileManager.default.temporaryDirectory
    let catalogPath = tmpDir.appendingPathComponent("catalog-\(UUID().uuidString).db").path
    let stagePath = XmltvSqliteWriter.stageDbPath(for: catalogPath, jobId: "src:gz/0")
    defer { XmltvSqliteWriter.cleanupStageFile(stagePath) }

    let decoder = StreamingGzipDecoder()
    let scanner = XmltvByteScanner(sourceId: "src-gz", runId: 7, fromMs: fromMs, toMs: toMs)
    let writer = try XmltvSqliteWriter(stageDbPath: stagePath, batchSize: 1)

    // Feed tiny 17-byte chunks to verify streaming boundary safety
    var offset = 0
    while offset < gz.count {
      let end = min(gz.count, offset + 17)
      let slice = Array(gz[offset..<end])
      try slice.withUnsafeBufferPointer { ptr in
        try decoder.feed(ptr) { xmlChunk in
          try scanner.feed(xmlChunk) { row in
            try writer.write(row)
          }
        }
      }
      offset = end
    }
    try decoder.finish { xmlChunk in
      try scanner.feed(xmlChunk) { row in
        try writer.write(row)
      }
    }
    let summary = try scanner.finish { row in
      try writer.write(row)
    }
    try writer.finish()

    #expect(summary.stagedProgrammes == 2)
    #expect(summary.stagedCounts["c1"] == 2)

    var verifyDb: OpaquePointer?
    let verifyOpen = sqlite3_open_v2(stagePath, &verifyDb, SQLITE_OPEN_READONLY, nil)
    #expect(verifyOpen == SQLITE_OK)
    defer { sqlite3_close(verifyDb) }

    var qStmt: OpaquePointer?
    let prep = sqlite3_prepare_v2(
      verifyDb,
      "SELECT start, stop, title, genre FROM programmes_next WHERE source_id = 'src-gz' ORDER BY start ASC",
      -1,
      &qStmt,
      nil
    )
    #expect(prep == SQLITE_OK)
    defer { sqlite3_finalize(qStmt) }

    var readRows: [(Int64, Int64, String, String)] = []
    while sqlite3_step(qStmt) == SQLITE_ROW {
      let s = sqlite3_column_int64(qStmt, 0)
      let e = sqlite3_column_int64(qStmt, 1)
      let t = String(cString: sqlite3_column_text(qStmt, 2))
      let g = String(cString: sqlite3_column_text(qStmt, 3))
      readRows.append((s, e, t, g))
    }

    let t10 = try #require(XmltvTextHelpers.parseXmltvTime("20261125100000 +0000"))
    let t11 = try #require(XmltvTextHelpers.parseXmltvTime("20261125110000 +0000"))
    #expect(readRows.count == 2)
    #expect(readRows[0].0 == t10)
    #expect(readRows[0].1 == t11) // Clamped from 11:30 to 11:00!
    #expect(readRows[0].2 == "Match 1")
    #expect(readRows[0].3 == "sports")
    #expect(readRows[1].0 == t11)
    #expect(readRows[1].1 == t11 + XmltvByteScanner.openEndMs)
    #expect(readRows[1].2 == "Open Show")
    #expect(readRows[1].3 == "movie")
  }

  @Test("matches foldText Turkish and German parity and timezones")
  func foldingAndTimezones() throws {
    let folded = XmltvTextHelpers.foldText("İSTANBUL Işık Straße 2026!")
    #expect(folded == "istanbul isik strasse 2026")
    let utc = XmltvTextHelpers.parseXmltvTime("20261125120000 +0000")
    let istanbul = XmltvTextHelpers.parseXmltvTime("20261125150000", defaultTimeZone: "Europe/Istanbul")
    #expect(utc != nil)
    #expect(utc == istanbul)
    let kidsGenre = XmltvTextHelpers.normalizeEpgGenre(["Çizgi Film"])
    #expect(kidsGenre == "kids")
  }

  @Test("rejects truncated gzip streams in finish() and supports multi-member gzip")
  func truncatedAndMultiMemberGzip() throws {
    let payload = Array("<tv><channel id=\"gz1\"><display-name>One</display-name></channel></tv>".utf8)
    let gz = try gzipCompress(payload)
    #expect(gz.count > 12)

    // Truncated single member (missing trailer/tail bytes)
    let truncated = Array(gz.prefix(gz.count - 8))
    let truncatedDecoder = StreamingGzipDecoder()
    try truncated.withUnsafeBufferPointer { ptr in
      try truncatedDecoder.feed(ptr) { _ in }
    }
    #expect(throws: XmltvStreamError.gzipCorrupt) {
      try truncatedDecoder.finish { _ in }
    }

    // Valid multi-member concatenated gzip fed across exact member boundary
    let member2 = try gzipCompress(Array("<tv><channel id=\"gz2\"/></tv>".utf8))
    let multiDecoder = StreamingGzipDecoder()
    var combined: [UInt8] = []
    try gz.withUnsafeBufferPointer { ptr in
      try multiDecoder.feed(ptr) { combined.append(contentsOf: $0) }
    }
    try member2.withUnsafeBufferPointer { ptr in
      try multiDecoder.feed(ptr) { combined.append(contentsOf: $0) }
    }
    try multiDecoder.finish { combined.append(contentsOf: $0) }
    #expect(String(decoding: combined, as: UTF8.self).contains("gz2"))

    // Truncated second member must still throw gzipCorrupt
    let truncatedSecond = Array(member2.prefix(member2.count - 6))
    let multiTruncDecoder = StreamingGzipDecoder()
    try gz.withUnsafeBufferPointer { ptr in
      try multiTruncDecoder.feed(ptr) { _ in }
    }
    try truncatedSecond.withUnsafeBufferPointer { ptr in
      try multiTruncDecoder.feed(ptr) { _ in }
    }
    #expect(throws: XmltvStreamError.gzipCorrupt) {
      try multiTruncDecoder.finish { _ in }
    }
  }

  @Test("matchTagName returns mismatch before EOF length check and parses trailing channel at EOF")
  func trailingShortChannelAtEof() throws {
    let shortChan = Array("<channel/>".utf8)
    let progBytes = Array("programme".utf8)
    let chanBytes = Array("channel".utf8)
    #expect(XmltvByteTokens.matchTagName(shortChan, at: 1, limit: shortChan.count, expected: progBytes) == 0)
    #expect(XmltvByteTokens.matchTagName(shortChan, at: 1, limit: shortChan.count, expected: chanBytes) == 1)

    let partialProg = Array("<progr".utf8)
    #expect(XmltvByteTokens.matchTagName(partialProg, at: 1, limit: partialProg.count, expected: progBytes) == -1)

    let fromMs = try #require(XmltvTextHelpers.parseXmltvTime("20261125000000 +0000"))
    let toMs = try #require(XmltvTextHelpers.parseXmltvTime("20261126000000 +0000"))
    let scanner = XmltvByteScanner(sourceId: "s1", runId: 1, fromMs: fromMs, toMs: toMs)
    let eofBytes = Array("<tv><channel id=\"x\"/>".utf8)
    try eofBytes.withUnsafeBufferPointer { ptr in
      try scanner.feed(ptr) { _ in }
    }
    let summary = try scanner.finish { _ in }
    #expect(summary.channels.count == 1)
    #expect(summary.channels[0].id == "x")
  }

  @Test("ignores nested programme metadata tags inside wrapper elements")
  func ignoresNestedProgrammeMetadata() throws {
    let xml = """
    <tv>
      <programme start="20261125120000 +0000" stop="20261125130000 +0000" channel="ch1">
        <credits>
          <title>Dr.</title>
          <sub-title>Nested Sub</sub-title>
          <desc>Nested Desc</desc>
          <category>NestedCat</category>
          <episode-num system="xmltv_ns">9.9.</episode-num>
        </credits>
        <title>Top Title</title>
        <sub-title>Top Sub</sub-title>
        <desc>Top Desc</desc>
        <category>News</category>
        <episode-num system="onscreen">S01E02</episode-num>
      </programme>
    </tv>
    """
    let fromMs = try #require(XmltvTextHelpers.parseXmltvTime("20261125000000 +0000"))
    let toMs = try #require(XmltvTextHelpers.parseXmltvTime("20261126000000 +0000"))
    let scanner = XmltvByteScanner(sourceId: "src-1", runId: 1, fromMs: fromMs, toMs: toMs)
    var rows: [StagedProgrammeRow] = []
    let bytes = Array(xml.utf8)
    try bytes.withUnsafeBufferPointer { ptr in
      try scanner.feed(ptr) { rows.append($0) }
    }
    _ = try scanner.finish { rows.append($0) }

    #expect(rows.count == 1)
    #expect(rows[0].title == "Top Title")
    #expect(rows[0].subTitle == "Top Sub")
    #expect(rows[0].description == "Top Desc")
    #expect(rows[0].categoriesJson == "[\"News\"]")
    #expect(rows[0].episodeNum == "S01E02")
  }

  @Test("strips Authorization, Proxy-Authorization, and Cookie on cross-origin redirects")
  func crossOriginRedirectHeaderStripping() throws {
    let orig = try #require(URL(string: "https://guide.example:443/epg.xml"))
    let sameOrigin = try #require(URL(string: "https://GUIDE.EXAMPLE/v2/epg.xml"))
    let diffHost = try #require(URL(string: "https://cdn.other.example/epg.xml"))
    let diffScheme = try #require(URL(string: "http://guide.example/epg.xml"))
    let diffPort = try #require(URL(string: "https://guide.example:8443/epg.xml"))

    #expect(XmltvRedirectPolicy.isSameOrigin(orig, sameOrigin))
    #expect(!XmltvRedirectPolicy.isSameOrigin(orig, diffHost))
    #expect(!XmltvRedirectPolicy.isSameOrigin(orig, diffScheme))
    #expect(!XmltvRedirectPolicy.isSameOrigin(orig, diffPort))

    func makeReq(_ url: URL) -> URLRequest {
      var req = URLRequest(url: url)
      req.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
      req.setValue("Basic proxy", forHTTPHeaderField: "Proxy-Authorization")
      req.setValue("session=abc", forHTTPHeaderField: "Cookie")
      req.setValue("ELV/1.0", forHTTPHeaderField: "User-Agent")
      return req
    }

    let kept = XmltvRedirectPolicy.sanitizedRedirectRequest(originalUrl: orig, newRequest: makeReq(sameOrigin))
    #expect(kept.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(kept.value(forHTTPHeaderField: "Proxy-Authorization") == "Basic proxy")
    #expect(kept.value(forHTTPHeaderField: "Cookie") == "session=abc")
    #expect(kept.value(forHTTPHeaderField: "User-Agent") == "ELV/1.0")

    for target in [diffHost, diffScheme, diffPort] {
      let stripped = XmltvRedirectPolicy.sanitizedRedirectRequest(originalUrl: orig, newRequest: makeReq(target))
      #expect(stripped.value(forHTTPHeaderField: "Authorization") == nil)
      #expect(stripped.value(forHTTPHeaderField: "Proxy-Authorization") == nil)
      #expect(stripped.value(forHTTPHeaderField: "Cookie") == nil)
      #expect(stripped.value(forHTTPHeaderField: "User-Agent") == "ELV/1.0")
    }
  }

  @Test("cleanupStageFile deletes only matching temp stage files and sidecars")
  func cleanupStageFileSafety() throws {
    let fm = FileManager.default
    let dir = fm.temporaryDirectory.appendingPathComponent("xmltv-cleanup-\(UUID().uuidString)")
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: dir) }

    let catalog = dir.appendingPathComponent("catalog.db").path
    fm.createFile(atPath: catalog, contents: Data("keep".utf8))
    let stagePath = XmltvSqliteWriter.stageDbPath(for: catalog, jobId: "src:1/slot:0")
    #expect(XmltvSqliteWriter.isValidStageFilePath(stagePath))
    #expect(!XmltvSqliteWriter.isValidStageFilePath(catalog))

    for suffix in ["", "-wal", "-shm", "-journal"] {
      fm.createFile(atPath: stagePath + suffix, contents: Data("tmp".utf8))
    }

    XmltvSqliteWriter.cleanupStageFile(catalog)
    #expect(fm.fileExists(atPath: catalog))

    XmltvSqliteWriter.cleanupStageFile(stagePath)
    for suffix in ["", "-wal", "-shm", "-journal"] {
      #expect(!fm.fileExists(atPath: stagePath + suffix))
    }
    #expect(fm.fileExists(atPath: catalog))
  }
}

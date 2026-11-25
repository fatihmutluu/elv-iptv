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
    let dbURL = tmpDir.appendingPathComponent("xmltv-test-\(UUID().uuidString).sqlite")
    defer { try? FileManager.default.removeItem(at: dbURL) }

    var setupDb: OpaquePointer?
    let openRc = sqlite3_open(dbURL.path, &setupDb)
    #expect(openRc == SQLITE_OK)
    let createSql = """
    CREATE TABLE programmes_next (
      source_id TEXT NOT NULL,
      guide_id TEXT NOT NULL,
      start INTEGER NOT NULL,
      stop INTEGER NOT NULL,
      title TEXT NOT NULL,
      sub_title TEXT,
      description TEXT,
      categories_json TEXT,
      episode_num TEXT,
      icon TEXT,
      run_id INTEGER NOT NULL,
      genre TEXT,
      flags INTEGER NOT NULL DEFAULT 0,
      rating_system TEXT,
      rating_value TEXT,
      title_fold TEXT NOT NULL DEFAULT '',
      description_fold TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (source_id, guide_id, start)
    ) WITHOUT ROWID;
    """
    let createRc = sqlite3_exec(setupDb, createSql, nil, nil, nil)
    #expect(createRc == SQLITE_OK)
    sqlite3_close(setupDb)

    let decoder = StreamingGzipDecoder()
    let scanner = XmltvByteScanner(sourceId: "src-gz", runId: 7, fromMs: fromMs, toMs: toMs)
    let writer = try XmltvSqliteWriter(dbPath: dbURL.path, batchSize: 1)

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
    let verifyOpen = sqlite3_open_v2(dbURL.path, &verifyDb, SQLITE_OPEN_READONLY, nil)
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
}

package io.github.fatihmutluu.elv.xmltvnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URL
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.util.zip.GZIPOutputStream

class XmltvByteScannerTest {

  private fun gzip(text: String): ByteArray {
    val out = ByteArrayOutputStream()
    GZIPOutputStream(out).use { gz ->
      gz.write(text.toByteArray(StandardCharsets.UTF_8))
    }
    return out.toByteArray()
  }

  @Test
  fun `parses channels programmes entities ratings flags and episode numbers`() {
    val xml = """
      <?xml version="1.0" encoding="UTF-8"?>
      <tv>
        <channel id="ch1">
          <display-name>News &amp; Weather</display-name>
          <display-name>News HD</display-name>
          <icon src="https://cdn.example/news.png" />
          <lcn>101</lcn>
        </channel>
        <channel id="ch1">
          <display-name>News HD</display-name>
          <display-name>News Alt</display-name>
        </channel>
        <programme start="20261125120000 +0000" stop="20261125130000 +0000" channel="ch1">
          <title>&lt;b&gt;Breaking&lt;/b&gt; &quot;News&quot; &#38; &#x21;</title>
          <sub-title>&lt;i&gt;Midday&lt;/i&gt; Edition</sub-title>
          <desc>Top stories from İstanbul.</desc>
          <category>News</category>
          <category>Politics</category>
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
    """.trimIndent()

    val rows = ArrayList<StagedProgrammeRow>()
    val fromMs = XmltvTextHelpers.parseXmltvTime("20261125000000 +0000")!!
    val toMs = XmltvTextHelpers.parseXmltvTime("20261126000000 +0000")!!
    val scanner = XmltvByteScanner("src-1", 42L, fromMs, toMs)
    val summary = scanner.scanStream(ByteArrayInputStream(xml.toByteArray(StandardCharsets.UTF_8))) {
      rows.add(it)
    }

    assertEquals(1, summary.channels.size)
    assertEquals("ch1", summary.channels[0].id)
    assertEquals(listOf("News & Weather", "News HD", "News Alt"), summary.channels[0].names)
    assertEquals("https://cdn.example/news.png", summary.channels[0].icon)
    assertEquals("101", summary.channels[0].lcn)
    assertEquals(1, summary.seenProgrammes)
    assertEquals(1, summary.stagedProgrammes)
    assertEquals(1, summary.stagedCounts["ch1"])
    assertEquals(1, rows.size)

    val row = rows[0]
    assertEquals("src-1", row.sourceId)
    assertEquals(42L, row.runId)
    assertEquals("Breaking \"News\" & !", row.title)
    assertEquals("Midday Edition", row.subTitle)
    assertEquals("Top stories from İstanbul.", row.description)
    assertEquals("[\"News\",\"Politics\"]", row.categoriesJson)
    assertEquals("1.4.", row.episodeNum)
    assertEquals("https://cdn.example/prog.png", row.icon)
    assertEquals("news", row.genre)
    assertEquals(15, row.flags)
    assertEquals("MPAA", row.ratingSystem)
    assertEquals("TV-PG", row.ratingValue)
    assertEquals("breaking news", row.titleFold)
    assertEquals("top stories from istanbul", row.descriptionFold)
  }

  @Test
  fun `filters time window and clamps open and overlapping programmes`() {
    val xml = """
      <tv>
        <programme start="20261124080000 +0000" stop="20261124090000 +0000" channel="c1"><title>Too Old</title></programme>
        <programme start="20261125100000 +0000" stop="20261125113000 +0000" channel="c1"><title>First</title></programme>
        <programme start="20261125110000 +0000" channel="c1"><title>Open Middle</title></programme>
        <programme start="20261125120000 +0000" channel="c1"><title>Open Tail</title></programme>
        <programme start="20261127000000 +0000" stop="20261127010000 +0000" channel="c1"><title>Too Far</title></programme>
      </tv>
    """.trimIndent()

    val rows = ArrayList<StagedProgrammeRow>()
    val fromMs = XmltvTextHelpers.parseXmltvTime("20261125000000 +0000")!!
    val toMs = XmltvTextHelpers.parseXmltvTime("20261126000000 +0000")!!
    val scanner = XmltvByteScanner("s1", 1L, fromMs, toMs)
    val summary = scanner.scanStream(ByteArrayInputStream(xml.toByteArray(StandardCharsets.UTF_8))) {
      rows.add(it)
    }

    assertEquals(3, summary.seenProgrammes)
    assertEquals(3, summary.stagedProgrammes)
    // First emitted at 11:30, then re-emitted clamped to 11:00, then Open Middle (11:00..12:00), then Open Tail (12:00..12:30)
    val byStart = rows.associateBy { it.start }
    val t10 = XmltvTextHelpers.parseXmltvTime("20261125100000 +0000")!!
    val t11 = XmltvTextHelpers.parseXmltvTime("20261125110000 +0000")!!
    val t12 = XmltvTextHelpers.parseXmltvTime("20261125120000 +0000")!!
    assertEquals(t11, byStart[t10]?.stop)
    assertEquals(t12, byStart[t11]?.stop)
    assertEquals(t12 + XmltvByteScanner.OPEN_END_MS, byStart[t12]?.stop)
  }

  @Test
  fun `detects gzip magic bytes transparently`() {
    val xml = """
      <tv>
        <channel id="gz1"><display-name>Gzipped Sports</display-name></channel>
        <programme start="20261125140000 +0000" stop="20261125150000 +0000" channel="gz1">
          <title>Derby Match</title>
          <category>Futbol</category>
        </programme>
      </tv>
    """.trimIndent()

    val rows = ArrayList<StagedProgrammeRow>()
    val fromMs = XmltvTextHelpers.parseXmltvTime("20261125000000 +0000")!!
    val toMs = XmltvTextHelpers.parseXmltvTime("20261126000000 +0000")!!
    val scanner = XmltvByteScanner("s1", 9L, fromMs, toMs)
    val summary = scanner.scanStream(ByteArrayInputStream(gzip(xml)), forceGzip = false) {
      rows.add(it)
    }

    assertEquals(1, summary.channels.size)
    assertEquals("Gzipped Sports", summary.channels[0].names[0])
    assertEquals(1, rows.size)
    assertEquals("sports", rows[0].genre)
  }

  @Test
  fun `parses timestamps with offsets and defaultTimeZone fallback`() {
    val utc = XmltvTextHelpers.parseXmltvTime("20261125120000 +0000")
    val plusTwo = XmltvTextHelpers.parseXmltvTime("20261125140000 +0200")
    val colonOffset = XmltvTextHelpers.parseXmltvTime("20261125140000 +02:00")
    assertNotNull(utc)
    assertEquals(utc, plusTwo)
    assertEquals(utc, colonOffset)

    val istanbul = XmltvTextHelpers.parseXmltvTime("20261125150000", "Europe/Istanbul")
    assertEquals(utc, istanbul)
    assertNull(XmltvTextHelpers.parseXmltvTime("not-a-date"))
    assertNull(XmltvTextHelpers.parseXmltvTime("20260230120000 +0000"))
  }

  @Test
  fun `matches foldText Turkish and German parity and normalizes genres and flags`() {
    assertEquals("istanbul isik strasse 2026", XmltvTextHelpers.foldText("İSTANBUL Işık Straße 2026!"))
    assertEquals("hello world 42", XmltvTextHelpers.foldText("  Hello---World_42  "))
    assertEquals("kids", XmltvTextHelpers.normalizeEpgGenre(listOf("Çizgi Film")))
    assertEquals("news", XmltvTextHelpers.normalizeEpgGenre(listOf("Hava Durumu")))
    assertEquals("movie", XmltvTextHelpers.normalizeEpgGenre(listOf("Sinema")))
    assertEquals("series", XmltvTextHelpers.normalizeEpgGenre(listOf("Belgesel")))
    assertEquals("other", XmltvTextHelpers.normalizeEpgGenre(listOf("Unclassified")))
    assertNull(XmltvTextHelpers.normalizeEpgGenre(emptyList()))
    assertEquals(5, XmltvTextHelpers.encodeProgrammeFlags(isLive = true, isNew = false, isPremiere = true, previouslyShown = false))
    assertTrue(XmltvTextHelpers.isValidXmltvNs("0.1.0/1"))
  }

  @Test
  fun `matchTagName returns mismatch before EOF length check and parses trailing self-closing channel`() {
    val shortChannel = "<channel/>".toByteArray(StandardCharsets.US_ASCII)
    val progBytes = "programme".toByteArray(StandardCharsets.US_ASCII)
    val chanBytes = "channel".toByteArray(StandardCharsets.US_ASCII)
    assertEquals(0, XmltvByteTokens.matchTagName(shortChannel, 1, shortChannel.size, progBytes))
    assertEquals(1, XmltvByteTokens.matchTagName(shortChannel, 1, shortChannel.size, chanBytes))

    val partialProg = "<progr".toByteArray(StandardCharsets.US_ASCII)
    assertEquals(-1, XmltvByteTokens.matchTagName(partialProg, 1, partialProg.size, progBytes))

    val eofXml = """<tv><channel id="x"/>"""
    val fromMs = XmltvTextHelpers.parseXmltvTime("20261125000000 +0000")!!
    val toMs = XmltvTextHelpers.parseXmltvTime("20261126000000 +0000")!!
    val scanner = XmltvByteScanner("s1", 1L, fromMs, toMs)
    val summary = scanner.scanStream(ByteArrayInputStream(eofXml.toByteArray(StandardCharsets.UTF_8))) {}
    assertEquals(1, summary.channels.size)
    assertEquals("x", summary.channels[0].id)
  }

  @Test
  fun `ignores nested programme metadata tags inside wrapper elements`() {
    val xml = """
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
    """.trimIndent()
    val rows = ArrayList<StagedProgrammeRow>()
    val fromMs = XmltvTextHelpers.parseXmltvTime("20261125000000 +0000")!!
    val toMs = XmltvTextHelpers.parseXmltvTime("20261126000000 +0000")!!
    val scanner = XmltvByteScanner("src-1", 1L, fromMs, toMs)
    scanner.scanStream(ByteArrayInputStream(xml.toByteArray(StandardCharsets.UTF_8))) { rows.add(it) }

    assertEquals(1, rows.size)
    val row = rows[0]
    assertEquals("Top Title", row.title)
    assertEquals("Top Sub", row.subTitle)
    assertEquals("Top Desc", row.description)
    assertEquals("[\"News\"]", row.categoriesJson)
    assertEquals("S01E02", row.episodeNum)
  }

  @Test
  fun `strips sensitive auth and cookie headers across cross-origin redirects`() {
    val orig = URL("https://guide.example:443/epg.xml")
    val sameOriginImplicitPort = URL("https://GUIDE.EXAMPLE/v2/epg.xml")
    val diffHost = URL("https://cdn.other.example/epg.xml")
    val diffScheme = URL("http://guide.example/epg.xml")
    val diffPort = URL("https://guide.example:8443/epg.xml")

    assertTrue(NativeXmltvStager.isSameOrigin(orig, sameOriginImplicitPort))
    assertFalse(NativeXmltvStager.isSameOrigin(orig, diffHost))
    assertFalse(NativeXmltvStager.isSameOrigin(orig, diffScheme))
    assertFalse(NativeXmltvStager.isSameOrigin(orig, diffPort))

    val headers = mapOf(
      "Authorization" to "Bearer secret",
      "Proxy-Authorization" to "Basic proxy",
      "Cookie" to "session=abc",
      "User-Agent" to "ELV/1.0",
      "Accept-Encoding" to "identity",
    )
    val kept = NativeXmltvStager.headersForHop(headers, orig, sameOriginImplicitPort)
    assertEquals("Bearer secret", kept["Authorization"])
    assertEquals("Basic proxy", kept["Proxy-Authorization"])
    assertEquals("session=abc", kept["Cookie"])
    assertEquals("ELV/1.0", kept["User-Agent"])
    assertFalse(kept.containsKey("Accept-Encoding"))

    for (cross in listOf(diffHost, diffScheme, diffPort)) {
      val stripped = NativeXmltvStager.headersForHop(headers, orig, cross)
      assertFalse(stripped.containsKey("Authorization"))
      assertFalse(stripped.containsKey("Proxy-Authorization"))
      assertFalse(stripped.containsKey("Cookie"))
      assertEquals("ELV/1.0", stripped["User-Agent"])
    }
  }

  @Test
  fun `cleanupStageFile deletes only valid stage db files and sidecars`() {
    val dir = Files.createTempDirectory("xmltv-stage-test").toFile()
    try {
      val catalog = File(dir, "catalog.db").apply { writeText("keep") }
      val stagePath = NativeXmltvStager.buildStageDbPath(catalog.absolutePath, "src:1/slot:0")
      assertTrue(NativeXmltvStager.isValidStageFilePath(stagePath))
      assertFalse(NativeXmltvStager.isValidStageFilePath(catalog.absolutePath))
      assertFalse(NativeXmltvStager.isValidStageFilePath("${catalog.absolutePath}.xmltv-stage-bad/name.db"))

      val stageDb = File(stagePath).apply { writeText("stage") }
      val stageWal = File("$stagePath-wal").apply { writeText("wal") }
      val stageShm = File("$stagePath-shm").apply { writeText("shm") }
      val stageJournal = File("$stagePath-journal").apply { writeText("journal") }

      NativeXmltvStager.cleanupStageFile(catalog.absolutePath)
      assertTrue(catalog.exists())

      NativeXmltvStager.cleanupStageFile(stagePath)
      assertFalse(stageDb.exists())
      assertFalse(stageWal.exists())
      assertFalse(stageShm.exists())
      assertFalse(stageJournal.exists())
      assertTrue(catalog.exists())
    } finally {
      dir.deleteRecursively()
    }
  }
}

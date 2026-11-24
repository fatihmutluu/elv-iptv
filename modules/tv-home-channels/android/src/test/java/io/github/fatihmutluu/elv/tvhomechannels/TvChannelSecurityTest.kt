package io.github.fatihmutluu.elv.tvhomechannels

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TvChannelSecurityTest {
  @Test
  fun `buildPlayDeepLinkUri encodes itemKey and kind without leaking credentials`() {
    assertEquals(
      "elviptv://play?key=live%3Asrc1%3Ach-42&kind=live",
      TvChannelSecurity.buildPlayDeepLinkUri("live:src1:ch-42", "live"),
    )
    assertEquals(
      "elviptv://play?key=vod%3Asrc1%3Amovie%2F99&kind=movie",
      TvChannelSecurity.buildPlayDeepLinkUri("vod:src1:movie/99", "movie"),
    )
    assertEquals(
      "elviptv://play?key=ep%3Asrc2%3As01e02%3Fa%3D1%26b%3D2%23x&kind=episode",
      TvChannelSecurity.buildPlayDeepLinkUri("ep:src2:s01e02?a=1&b=2#x", "episode"),
    )
    assertEquals(
      "elviptv://play?key=ch%20with%20space&kind=live",
      TvChannelSecurity.buildPlayDeepLinkUri("ch with space", "live"),
    )
  }

  @Test
  fun `buildPlayDeepLinkUri rejects empty, blank, control-char keys and unsupported kinds`() {
    val badKeys = listOf("", "   ", "ch\n1", "ch\r1", "ch\u00001", "ch\u007F1", "a".repeat(513))
    for (badKey in badKeys) {
      val failed = runCatching { TvChannelSecurity.buildPlayDeepLinkUri(badKey, "live") }.isFailure
      assertTrue("Expected key '$badKey' to be rejected", failed)
    }

    val badKinds = listOf("", "series", "LIVE", "channel", "vod")
    for (badKind in badKinds) {
      val failed = runCatching { TvChannelSecurity.buildPlayDeepLinkUri("live:1", badKind) }.isFailure
      assertTrue("Expected kind '$badKind' to be rejected", failed)
    }
  }

  @Test
  fun `isSafeLogoUrl allows valid public HTTP and HTTPS image URLs`() {
    val allowed = listOf(
      "https://cdn.example.org/logos/news.png",
      "http://images.example.net/posters/1234.jpg?size=large",
      "https://media.example.tv/icons/channel-1.webp",
      "https://8.8.8.8/logo.png",
      "https://93.184.216.34/poster.jpg",
      "https://172.32.0.1/logo.png",
      "https://100.63.0.1/logo.png",
      "https://100.128.0.1/logo.png",
      "https://[2001:4860:4860::8888]/logo.png",
      "https://[::ffff:8.8.8.8]/logo.png",
    )
    for (url in allowed) {
      assertTrue("Expected safe URL to be allowed: $url", TvChannelSecurity.isSafeLogoUrl(url))
    }
  }

  @Test
  fun `isSafeLogoUrl blocks SSRF private, loopback, link-local, metadata, CGNAT, multicast, and ULA targets`() {
    val blocked = listOf(
      // RFC 1918 private IPv4
      "http://10.0.0.1/logo.png",
      "https://172.16.0.1/logo.png",
      "https://172.31.255.254/logo.png",
      "http://192.168.1.10/logo.png",
      // Loopback & unspecified
      "http://127.0.0.1/logo.png",
      "http://127.255.255.254/logo.png",
      "http://0.0.0.0/logo.png",
      "http://[::1]/logo.png",
      "http://[::]/logo.png",
      // Link-local & cloud metadata
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/logo.png",
      "http://[fe80::1%25eth0]/logo.png",
      // CGNAT, multicast, reserved
      "http://100.64.0.1/logo.png",
      "http://100.127.255.254/logo.png",
      "http://224.0.0.1/logo.png",
      "http://240.0.0.1/logo.png",
      "http://255.255.255.255/logo.png",
      "http://[ff02::1]/logo.png",
      // IPv6 ULA & IPv4-mapped / NAT64 private
      "http://[fc00::1]/logo.png",
      "http://[fd12:3456::1]/logo.png",
      "http://[::ffff:127.0.0.1]/logo.png",
      "http://[::ffff:169.254.169.254]/logo.png",
      "http://[::ffff:7f00:1]/logo.png",
      "http://[::ffff:a9fe:a9fe]/logo.png",
      "http://[64:ff9b::10.0.0.1]/logo.png",
      // Local hostnames & numeric/octal/hex shorthands
      "http://localhost/logo.png",
      "https://api.localhost/logo.png",
      "http://nas.local/logo.png",
      "http://metadata.internal/logo.png",
      "http://0177.0.0.1/logo.png",
      "http://2130706433/logo.png",
      "http://0x7f000001/logo.png",
      "http://127.1/logo.png",
    )
    for (url in blocked) {
      assertFalse("Expected SSRF URL to be blocked: $url", TvChannelSecurity.isSafeLogoUrl(url))
    }
  }

  @Test
  fun `isSafeLogoUrl blocks userinfo credentials, SVG paths, non-HTTP schemes, and control chars`() {
    val blocked = listOf(
      "https://user:pass@cdn.example.org/logo.png",
      "https://token@cdn.example.org/logo.png",
      "https://cdn.example.org/logo.svg",
      "https://cdn.example.org/logo.SVG?v=2",
      "https://cdn.example.org/logo.svgz",
      "https://cdn.example.org/logo%2esvg",
      "file:///etc/passwd",
      "content://io.github.fatihmutluu.elv/logo.png",
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "ftp://cdn.example.org/logo.png",
      "",
      "https://cdn.example.org/logo.png\n",
      "https://cdn.example.org/logo with space.png",
    )
    for (url in blocked) {
      assertFalse("Expected unsafe URL to be blocked: $url", TvChannelSecurity.isSafeLogoUrl(url))
    }
  }

  @Test
  fun `isBlockedInetAddress rejects private and loopback bytes and allows public IPs`() {
    assertTrue(TvChannelSecurity.isBlockedInetAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))))
    assertTrue(TvChannelSecurity.isBlockedInetAddress(InetAddress.getByAddress(byteArrayOf(10, 0, 0, 5))))
    assertTrue(TvChannelSecurity.isBlockedInetAddress(InetAddress.getByAddress(byteArrayOf(169.toByte(), 254.toByte(), 169.toByte(), 254.toByte()))))
    assertTrue(TvChannelSecurity.isBlockedInetAddress(InetAddress.getByAddress(byteArrayOf(100, 64, 0, 1))))
    assertTrue(
      TvChannelSecurity.isBlockedInetAddress(
        InetAddress.getByAddress(byteArrayOf(0xFD.toByte(), 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)),
      ),
    )

    assertFalse(TvChannelSecurity.isBlockedInetAddress(InetAddress.getByAddress(byteArrayOf(93, 184.toByte(), 216.toByte(), 34))))
    assertFalse(
      TvChannelSecurity.isBlockedInetAddress(
        InetAddress.getByAddress(byteArrayOf(0x20, 0x01, 0x48, 0x60, 0x48, 0x60, 0, 0, 0, 0, 0, 0, 0, 0, 0x88.toByte(), 0x88.toByte())),
      ),
    )
  }

  @Test
  fun `isSafeImageContentType requires image MIME type and rejects SVG`() {
    assertTrue(TvChannelSecurity.isSafeImageContentType("image/png"))
    assertTrue(TvChannelSecurity.isSafeImageContentType("image/jpeg; charset=utf-8"))
    assertTrue(TvChannelSecurity.isSafeImageContentType("IMAGE/WEBP"))
    assertTrue(TvChannelSecurity.isSafeImageContentType("image/gif"))

    assertFalse(TvChannelSecurity.isSafeImageContentType(null))
    assertFalse(TvChannelSecurity.isSafeImageContentType(""))
    assertFalse(TvChannelSecurity.isSafeImageContentType("image/"))
    assertFalse(TvChannelSecurity.isSafeImageContentType("image/svg+xml"))
    assertFalse(TvChannelSecurity.isSafeImageContentType("image/svg+xml; charset=utf-8"))
    assertFalse(TvChannelSecurity.isSafeImageContentType("text/html"))
    assertFalse(TvChannelSecurity.isSafeImageContentType("application/octet-stream"))

    assertEquals(".jpg", TvChannelSecurity.extensionForImageContentType("image/jpeg; charset=utf-8"))
    assertEquals(".webp", TvChannelSecurity.extensionForImageContentType("image/webp"))
    assertEquals(".gif", TvChannelSecurity.extensionForImageContentType("image/gif"))
    assertEquals(".png", TvChannelSecurity.extensionForImageContentType("image/png"))
  }

  @Test
  fun `isValidRasterImageHeader accepts PNG, JPEG, WebP, and GIF magic bytes and rejects non-raster payloads`() {
    val png = byteArrayOf(
      0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00,
    )
    val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
    val webp = "RIFF\u0024\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)
    val gif87a = "GIF87a\u0001\u0000".toByteArray(Charsets.ISO_8859_1)
    val gif89a = "GIF89a\u0001\u0000".toByteArray(Charsets.ISO_8859_1)

    assertTrue(TvChannelSecurity.isValidRasterImageHeader(png))
    assertEquals(".png", TvChannelSecurity.extensionForRasterImageHeader(png))
    assertTrue(TvChannelSecurity.isValidRasterImageHeader(jpeg))
    assertEquals(".jpg", TvChannelSecurity.extensionForRasterImageHeader(jpeg))
    assertTrue(TvChannelSecurity.isValidRasterImageHeader(webp))
    assertEquals(".webp", TvChannelSecurity.extensionForRasterImageHeader(webp))
    assertTrue(TvChannelSecurity.isValidRasterImageHeader(gif87a))
    assertEquals(".gif", TvChannelSecurity.extensionForRasterImageHeader(gif87a))
    assertTrue(TvChannelSecurity.isValidRasterImageHeader(gif89a))
    assertEquals(".gif", TvChannelSecurity.extensionForRasterImageHeader(gif89a))

    val invalidPayloads = listOf(
      ByteArray(0),
      byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47), // truncated PNG
      byteArrayOf(0xFF.toByte(), 0xD8.toByte()), // truncated JPEG
      "RIFF\u0024\u0000\u0000\u0000WAVEfmt ".toByteArray(Charsets.ISO_8859_1), // RIFF WAV, not WEBP
      "GIF88a".toByteArray(Charsets.ISO_8859_1),
      "<!DOCTYPE html><html><body>not an image</body></html>".toByteArray(Charsets.UTF_8),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".toByteArray(Charsets.UTF_8),
      "<?xml version=\"1.0\"?><svg></svg>".toByteArray(Charsets.UTF_8),
      "plain text pretending to be image/png".toByteArray(Charsets.UTF_8),
    )
    for (payload in invalidPayloads) {
      assertFalse(
        "Expected non-raster payload to be rejected",
        TvChannelSecurity.isValidRasterImageHeader(payload),
      )
      assertNull(TvChannelSecurity.extensionForRasterImageHeader(payload))
    }
  }

  @Test
  fun `sanitizeChannels enforces MAX_CHANNELS, MAX_PROGRAMS_PER_CHANNEL, and strips unsafe fields`() {
    val excessPrograms = (1..25).map { idx ->
      TvProgramSpec(
        itemKey = "live:src1:ch-$idx",
        title = "Channel $idx",
        kind = "live",
        logoUrl = if (idx == 1) "http://169.254.169.254/secret.png" else "https://cdn.example.org/$idx.png",
        isLive = true,
      )
    }

    val sanitized = TvChannelSecurity.sanitizeChannels(
      listOf(
        TvChannelSpec(
          internalId = "unknown_channel",
          displayName = "Ignored",
          programs = listOf(TvProgramSpec(itemKey = "k1", title = "T1", kind = "live")),
        ),
        TvChannelSpec(
          internalId = "continue_watching",
          displayName = "  Continue Watching  ",
          isDefaultBrowsable = true,
          programs = listOf(
            TvProgramSpec(itemKey = "", title = "Empty Key", kind = "movie"),
            TvProgramSpec(itemKey = "bad\nkey", title = "Control Key", kind = "movie"),
            TvProgramSpec(itemKey = "vod:1", title = "  ", kind = "movie"),
            TvProgramSpec(
              itemKey = "vod:src1:42",
              title = "  Nature Doc  ",
              subtitle = "  Part 1  ",
              kind = "movie",
              logoUrl = "https://cdn.example.org/doc.jpg",
              durationMs = 3_600_000L,
              lastPlaybackPositionMs = 1_200_000L,
              isLive = false,
            ),
          ),
        ),
        TvChannelSpec(
          internalId = "favorites",
          displayName = "Favorites",
          programs = excessPrograms,
        ),
        TvChannelSpec(
          internalId = "favorites",
          displayName = "Duplicate Favorites",
          programs = listOf(TvProgramSpec(itemKey = "live:dup", title = "Dup", kind = "live")),
        ),
      ),
    )

    assertEquals(TvChannelSecurity.MAX_CHANNELS, sanitized.size)
    assertEquals("continue_watching", sanitized[0].internalId)
    assertEquals("Continue Watching", sanitized[0].displayName)
    assertEquals(1, sanitized[0].programs.size)
    assertEquals("Nature Doc", sanitized[0].programs[0].title)
    assertEquals("Part 1", sanitized[0].programs[0].subtitle)
    assertEquals("https://cdn.example.org/doc.jpg", sanitized[0].programs[0].logoUrl)

    assertEquals("favorites", sanitized[1].internalId)
    assertEquals(TvChannelSecurity.MAX_PROGRAMS_PER_CHANNEL, sanitized[1].programs.size)
    assertNull(sanitized[1].programs[0].logoUrl)
    assertEquals("https://cdn.example.org/2.png", sanitized[1].programs[1].logoUrl)
  }

  @Test
  fun `decideChannelSync respects COLUMN_BROWSABLE, removal tombstones, and one-time browsable request`() {
    // 1. Initial creation of default browsable channel requests browsable once.
    val initialCreate = TvChannelSecurity.decideChannelSync(
      existingChannelExists = false,
      existingBrowsable = false,
      wasCreatedBefore = false,
      wasBrowsableBefore = false,
      isRemovedTombstone = false,
      isDefaultBrowsable = true,
      browsableAlreadyRequested = false,
      hasPrograms = true,
    )
    assertEquals(ChannelSyncAction.CREATE_CHANNEL, initialCreate.action)
    assertTrue(initialCreate.requestBrowsable)

    // 2. Existing channel toggled off by user (COLUMN_BROWSABLE == 0) is skipped & tombstoned.
    val hiddenByUser = TvChannelSecurity.decideChannelSync(
      existingChannelExists = true,
      existingBrowsable = false,
      wasCreatedBefore = true,
      wasBrowsableBefore = true,
      isRemovedTombstone = false,
      isDefaultBrowsable = true,
      browsableAlreadyRequested = true,
      hasPrograms = true,
    )
    assertEquals(ChannelSyncAction.SKIP, hiddenByUser.action)
    assertFalse(hiddenByUser.requestBrowsable)
    assertTrue(hiddenByUser.markRemovedTombstone)

    // 3. Previously created channel deleted externally is tombstoned and never recreated.
    val deletedByUser = TvChannelSecurity.decideChannelSync(
      existingChannelExists = false,
      existingBrowsable = false,
      wasCreatedBefore = true,
      wasBrowsableBefore = true,
      isRemovedTombstone = false,
      isDefaultBrowsable = true,
      browsableAlreadyRequested = true,
      hasPrograms = true,
    )
    assertEquals(ChannelSyncAction.SKIP, deletedByUser.action)
    assertTrue(deletedByUser.markRemovedTombstone)

    // 4. Existing channel re-enabled by user (COLUMN_BROWSABLE == 1) updates and clears tombstone.
    val reenabled = TvChannelSecurity.decideChannelSync(
      existingChannelExists = true,
      existingBrowsable = true,
      wasCreatedBefore = true,
      wasBrowsableBefore = true,
      isRemovedTombstone = true,
      isDefaultBrowsable = true,
      browsableAlreadyRequested = true,
      hasPrograms = true,
    )
    assertEquals(ChannelSyncAction.UPDATE_PROGRAMS, reenabled.action)
    assertTrue(reenabled.clearRemovedTombstone)
    assertTrue(reenabled.markWasBrowsable)
  }
}

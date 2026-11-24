package io.github.fatihmutluu.elv.tvhomechannels

import java.net.InetAddress
import java.net.URI
import java.util.Locale

/** Validated preview program specification ready for Android TV launcher publishing (`#273`). */
data class TvProgramSpec(
  val itemKey: String,
  val title: String,
  val subtitle: String? = null,
  val kind: String,
  val logoUrl: String? = null,
  val durationMs: Long? = null,
  val lastPlaybackPositionMs: Long? = null,
  val isLive: Boolean = false,
)

/** Validated preview channel specification capped to bounded channel/program limits (`#273`). */
data class TvChannelSpec(
  val internalId: String,
  val displayName: String,
  val isDefaultBrowsable: Boolean = false,
  val programs: List<TvProgramSpec>,
)

/** Action chosen by [TvChannelSecurity.decideChannelSync] for one preview channel. */
enum class ChannelSyncAction {
  CREATE_CHANNEL,
  UPDATE_PROGRAMS,
  SKIP,
}

/** Deterministic state-machine decision for channel creation, updates, and removal tombstones. */
data class ChannelSyncDecision(
  val action: ChannelSyncAction,
  val requestBrowsable: Boolean = false,
  val markRemovedTombstone: Boolean = false,
  val clearRemovedTombstone: Boolean = false,
  val markWasBrowsable: Boolean = false,
)

/**
 * Pure JVM-testable security, deep-link, SSRF, content-type, capping, and tombstone helpers
 * for Android TV Home Screen Preview Channels (`#273`).
 */
object TvChannelSecurity {
  const val MAX_CHANNELS: Int = 2
  const val MAX_PROGRAMS_PER_CHANNEL: Int = 20
  const val MAX_LOGO_BYTES: Int = 2 * 1024 * 1024
  const val MAX_CACHED_LOGOS: Int = 48
  const val MAX_REDIRECT_HOPS: Int = 2
  const val MAX_URL_CHARS: Int = 4096
  const val MAX_ITEM_KEY_CHARS: Int = 512

  const val PLAY_DEEP_LINK_SCHEME: String = "elviptv"
  const val PLAY_DEEP_LINK_HOST: String = "play"

  val ALLOWED_CHANNEL_IDS: Set<String> = setOf("continue_watching", "favorites")
  val ALLOWED_KINDS: Set<String> = setOf("live", "movie", "episode")

  private val MIME_SUBTYPE_PATTERN = Regex("^[a-z0-9.+-]+$")
  private val NUMERIC_IPV4_LABEL = Regex("^(?:0x[0-9a-f]+|[0-9]+)$")
  private val HEX_DIGITS = "0123456789ABCDEF"

  /**
   * Builds the canonical `elviptv://play?key=<encoded>&kind=<kind>` deep-link URI.
   * Rejects blank keys, control characters, oversized keys, and unsupported playback kinds.
   */
  fun buildPlayDeepLinkUri(itemKey: String, kind: String): String {
    require(isValidItemKey(itemKey)) {
      "itemKey must be a non-empty string without control characters"
    }
    require(kind in ALLOWED_KINDS) {
      "Unsupported TV deep-link kind: $kind"
    }
    return "$PLAY_DEEP_LINK_SCHEME://$PLAY_DEEP_LINK_HOST?key=${encodeUriComponent(itemKey)}&kind=$kind"
  }

  /** Returns true when `itemKey` is non-blank, bounded, and free of ASCII control characters. */
  fun isValidItemKey(itemKey: String): Boolean {
    if (itemKey.isEmpty() || itemKey.length > MAX_ITEM_KEY_CHARS || itemKey.isBlank()) return false
    for (ch in itemKey) {
      val code = ch.code
      if (code <= 0x1F || code == 0x7F) return false
    }
    return true
  }

  /**
   * Validates that `rawUrl` is an HTTP/HTTPS logo URL without credentials, control characters,
   * SSRF targets (private/loopback/link-local/unspecified/multicast/CGNAT/ULA IPs or local hostnames),
   * or SVG paths. Performs zero DNS lookups.
   */
  fun isSafeLogoUrl(rawUrl: String): Boolean {
    if (rawUrl.isEmpty() || rawUrl.length > MAX_URL_CHARS) return false
    for (ch in rawUrl) {
      val code = ch.code
      if (code <= 0x20 || code == 0x7F) return false
    }

    val uri = runCatching { URI(rawUrl) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return false
    if (scheme != "http" && scheme != "https") return false
    if (uri.rawUserInfo != null || uri.userInfo != null) return false

    val rawAuthority = uri.rawAuthority ?: return false
    if (rawAuthority.contains('@')) return false

    val rawHost = uri.host ?: return false
    if (rawHost.isEmpty() || rawHost.contains('%')) return false

    val host = rawHost
      .removePrefix("[")
      .removeSuffix("]")
      .trimEnd('.')
      .lowercase(Locale.ROOT)
    if (host.isEmpty()) return false

    if (isBlockedHostname(host)) return false
    if (isSvgPath(uri.rawPath) || isSvgPath(uri.path)) return false

    if (host.contains(':')) {
      val ipv6 = parseIpv6Bytes(host) ?: return false
      return !isBlockedIpv6Bytes(ipv6)
    }

    val ipv4 = parseCanonicalIpv4Bytes(host)
    if (ipv4 != null) {
      return !isBlockedIpv4Bytes(
        ipv4[0].toInt() and 0xFF,
        ipv4[1].toInt() and 0xFF,
        ipv4[2].toInt() and 0xFF,
        ipv4[3].toInt() and 0xFF,
      )
    }

    // Reject non-canonical numeric/octal/hex IPv4 shorthands (e.g. 0177.0.0.1, 2130706433, 0x7f000001).
    val labels = host.split('.')
    if (labels.all { NUMERIC_IPV4_LABEL.matches(it) }) return false

    return true
  }

  /**
   * Returns true if a DNS-resolved [InetAddress] falls in any private, loopback, link-local,
   * unspecified, multicast, CGNAT, reserved, or IPv6 ULA range.
   */
  fun isBlockedInetAddress(address: InetAddress): Boolean {
    if (
      address.isAnyLocalAddress ||
      address.isLoopbackAddress ||
      address.isLinkLocalAddress ||
      address.isSiteLocalAddress ||
      address.isMulticastAddress
    ) {
      return true
    }
    val bytes = address.address
    return when (bytes.size) {
      4 -> isBlockedIpv4Bytes(
        bytes[0].toInt() and 0xFF,
        bytes[1].toInt() and 0xFF,
        bytes[2].toInt() and 0xFF,
        bytes[3].toInt() and 0xFF,
      )
      16 -> isBlockedIpv6Bytes(bytes)
      else -> true
    }
  }

  /** Requires an explicit `image/*` MIME type and strictly rejects `image/svg+xml` (and any SVG subtype). */
  fun isSafeImageContentType(contentType: String?): Boolean {
    if (contentType.isNullOrBlank()) return false
    val mime = contentType.substringBefore(';').trim().lowercase(Locale.ROOT)
    if (!mime.startsWith("image/")) return false
    val subtype = mime.removePrefix("image/")
    if (subtype.isEmpty() || !MIME_SUBTYPE_PATTERN.matches(subtype)) return false
    if (subtype.contains("svg")) return false
    return true
  }

  /** Maps a validated `image/*` content type to a standard file extension for `FileProvider` MIME detection. */
  fun extensionForImageContentType(contentType: String?): String {
    val mime = contentType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
    return when (mime) {
      "image/jpeg", "image/jpg" -> ".jpg"
      "image/webp" -> ".webp"
      "image/gif" -> ".gif"
      else -> ".png"
    }
  }

  /**
   * Caps channels to [MAX_CHANNELS], deduplicates by allowed `internalId`, caps each channel's
   * valid programs to [MAX_PROGRAMS_PER_CHANNEL], and clears any unsafe logo URLs.
   */
  fun sanitizeChannels(channels: List<TvChannelSpec>): List<TvChannelSpec> {
    val seen = LinkedHashSet<String>()
    val result = ArrayList<TvChannelSpec>(MAX_CHANNELS)
    for (channel in channels) {
      if (result.size >= MAX_CHANNELS) break
      if (channel.internalId !in ALLOWED_CHANNEL_IDS || !seen.add(channel.internalId)) continue
      val displayName = channel.displayName.trim()
      if (displayName.isEmpty()) continue

      val validPrograms = ArrayList<TvProgramSpec>(minOf(channel.programs.size, MAX_PROGRAMS_PER_CHANNEL))
      for (program in channel.programs) {
        if (validPrograms.size >= MAX_PROGRAMS_PER_CHANNEL) break
        if (!isValidItemKey(program.itemKey) || program.kind !in ALLOWED_KINDS) continue
        val title = program.title.trim()
        if (title.isEmpty()) continue

        val subtitle = program.subtitle?.trim()?.takeIf { it.isNotEmpty() }
        val safeLogo = program.logoUrl?.trim()?.takeIf { it.isNotEmpty() && isSafeLogoUrl(it) }
        val durationMs = program.durationMs?.takeIf { it > 0L }
        val positionMs = program.lastPlaybackPositionMs?.takeIf { it >= 0L }

        validPrograms.add(
          TvProgramSpec(
            itemKey = program.itemKey,
            title = title,
            subtitle = subtitle,
            kind = program.kind,
            logoUrl = safeLogo,
            durationMs = durationMs,
            lastPlaybackPositionMs = positionMs,
            isLive = program.isLive,
          ),
        )
      }

      result.add(
        TvChannelSpec(
          internalId = channel.internalId,
          displayName = displayName,
          isDefaultBrowsable = channel.isDefaultBrowsable,
          programs = validPrograms,
        ),
      )
    }
    return result
  }

  /**
   * Computes the sync action for one channel while strictly honoring `COLUMN_BROWSABLE == 0`,
   * user-removal tombstones, and one-time `requestChannelBrowsable` on initial default creation.
   */
  fun decideChannelSync(
    existingChannelExists: Boolean,
    existingBrowsable: Boolean,
    wasCreatedBefore: Boolean,
    wasBrowsableBefore: Boolean,
    isRemovedTombstone: Boolean,
    isDefaultBrowsable: Boolean,
    browsableAlreadyRequested: Boolean,
    hasPrograms: Boolean,
  ): ChannelSyncDecision {
    if (existingChannelExists) {
      return if (existingBrowsable) {
        ChannelSyncDecision(
          action = ChannelSyncAction.UPDATE_PROGRAMS,
          clearRemovedTombstone = true,
          markWasBrowsable = true,
        )
      } else {
        ChannelSyncDecision(
          action = ChannelSyncAction.SKIP,
          markRemovedTombstone = wasBrowsableBefore,
        )
      }
    }

    if (isRemovedTombstone) {
      return ChannelSyncDecision(action = ChannelSyncAction.SKIP)
    }
    if (wasCreatedBefore) {
      return ChannelSyncDecision(
        action = ChannelSyncAction.SKIP,
        markRemovedTombstone = true,
      )
    }
    if (!hasPrograms) {
      return ChannelSyncDecision(action = ChannelSyncAction.SKIP)
    }

    val shouldRequestBrowsable = isDefaultBrowsable && !browsableAlreadyRequested
    return ChannelSyncDecision(
      action = ChannelSyncAction.CREATE_CHANNEL,
      requestBrowsable = shouldRequestBrowsable,
      markWasBrowsable = shouldRequestBrowsable,
    )
  }

  private fun isBlockedHostname(host: String): Boolean {
    return host == "localhost" ||
      host.endsWith(".localhost") ||
      host == "local" ||
      host.endsWith(".local") ||
      host == "localdomain" ||
      host.endsWith(".localdomain") ||
      host == "internal" ||
      host.endsWith(".internal") ||
      host == "ip6-localhost" ||
      host == "ip6-loopback"
  }

  private fun isSvgPath(path: String?): Boolean {
    if (path.isNullOrEmpty()) return false
    val lower = path.lowercase(Locale.ROOT)
    return lower.endsWith(".svg") || lower.endsWith(".svgz")
  }

  private fun parseCanonicalIpv4Bytes(host: String): ByteArray? {
    val parts = host.split('.')
    if (parts.size != 4) return null
    val out = ByteArray(4)
    for (i in 0 until 4) {
      val part = parts[i]
      if (part.isEmpty() || part.length > 3) return null
      if (part.length > 1 && part[0] == '0') return null
      if (!part.all { it in '0'..'9' }) return null
      val value = part.toIntOrNull() ?: return null
      if (value !in 0..255) return null
      out[i] = value.toByte()
    }
    return out
  }

  private fun isBlockedIpv4Bytes(a: Int, b: Int, c: Int, d: Int): Boolean {
    return a == 0 || // 0.0.0.0/8 unspecified
      a == 10 || // 10.0.0.0/8 RFC 1918
      (a == 100 && b in 64..127) || // 100.64.0.0/10 CGNAT
      a == 127 || // 127.0.0.0/8 loopback
      (a == 169 && b == 254) || // 169.254.0.0/16 link-local & cloud metadata
      (a == 172 && b in 16..31) || // 172.16.0.0/12 RFC 1918
      (a == 192 && b == 0 && c == 0) || // 192.0.0.0/24 IETF protocol
      (a == 192 && b == 0 && c == 2) || // 192.0.2.0/24 TEST-NET-1
      (a == 192 && b == 168) || // 192.168.0.0/16 RFC 1918
      (a == 198 && (b == 18 || b == 19)) || // 198.18.0.0/15 benchmarking
      a in 224..239 || // 224.0.0.0/4 multicast
      a >= 240 || // 240.0.0.0/4 reserved & broadcast
      (a == 255 && b == 255 && c == 255 && d == 255)
  }

  private fun parseIpv6Bytes(raw: String): ByteArray? {
    var input = raw
    val lastColon = input.lastIndexOf(':')
    if (lastColon >= 0 && input.indexOf('.', lastColon) >= 0) {
      val ipv4Part = input.substring(lastColon + 1)
      val ipv4Bytes = parseCanonicalIpv4Bytes(ipv4Part) ?: return null
      val hi = ((ipv4Bytes[0].toInt() and 0xFF) shl 8) or (ipv4Bytes[1].toInt() and 0xFF)
      val lo = ((ipv4Bytes[2].toInt() and 0xFF) shl 8) or (ipv4Bytes[3].toInt() and 0xFF)
      input = input.substring(0, lastColon + 1) +
        hi.toString(16) + ":" + lo.toString(16)
    }

    val doubleColonIndex = input.indexOf("::")
    if (doubleColonIndex >= 0 && input.indexOf("::", doubleColonIndex + 2) >= 0) {
      return null
    }

    val leftGroups: List<Int>
    val rightGroups: List<Int>
    if (doubleColonIndex >= 0) {
      val leftStr = input.substring(0, doubleColonIndex)
      val rightStr = input.substring(doubleColonIndex + 2)
      leftGroups = if (leftStr.isEmpty()) emptyList() else parseHexGroups(leftStr) ?: return null
      rightGroups = if (rightStr.isEmpty()) emptyList() else parseHexGroups(rightStr) ?: return null
      if (leftGroups.size + rightGroups.size > 7) return null
    } else {
      leftGroups = parseHexGroups(input) ?: return null
      rightGroups = emptyList()
      if (leftGroups.size != 8) return null
    }

    val zeroFill = 8 - leftGroups.size - rightGroups.size
    val groups = IntArray(8)
    var idx = 0
    for (g in leftGroups) groups[idx++] = g
    idx += zeroFill
    for (g in rightGroups) groups[idx++] = g

    val bytes = ByteArray(16)
    for (i in 0 until 8) {
      bytes[i * 2] = ((groups[i] ushr 8) and 0xFF).toByte()
      bytes[i * 2 + 1] = (groups[i] and 0xFF).toByte()
    }
    return bytes
  }

  private fun parseHexGroups(part: String): List<Int>? {
    val pieces = part.split(':')
    val out = ArrayList<Int>(pieces.size)
    for (piece in pieces) {
      if (piece.isEmpty() || piece.length > 4) return null
      val value = piece.toIntOrNull(16) ?: return null
      if (value !in 0..0xFFFF) return null
      out.add(value)
    }
    return out
  }

  private fun isBlockedIpv6Bytes(bytes: ByteArray): Boolean {
    if (bytes.size != 16) return true
    val b0 = bytes[0].toInt() and 0xFF
    val b1 = bytes[1].toInt() and 0xFF

    // Unspecified (::) and loopback (::1) and deprecated IPv4-compatible (::/96)
    var first12Zero = true
    for (i in 0 until 12) {
      if (bytes[i].toInt() != 0) {
        first12Zero = false
        break
      }
    }
    if (first12Zero) return true

    // IPv4-mapped (::ffff:0:0/96)
    var first10Zero = true
    for (i in 0 until 10) {
      if (bytes[i].toInt() != 0) {
        first10Zero = false
        break
      }
    }
    if (first10Zero && (bytes[10].toInt() and 0xFF) == 0xFF && (bytes[11].toInt() and 0xFF) == 0xFF) {
      return isBlockedIpv4Bytes(
        bytes[12].toInt() and 0xFF,
        bytes[13].toInt() and 0xFF,
        bytes[14].toInt() and 0xFF,
        bytes[15].toInt() and 0xFF,
      )
    }

    // Well-known NAT64 prefix (64:ff9b::/96)
    if (
      b0 == 0x00 &&
      b1 == 0x64 &&
      (bytes[2].toInt() and 0xFF) == 0xFF &&
      (bytes[3].toInt() and 0xFF) == 0x9B &&
      (4 until 12).all { bytes[it].toInt() == 0 }
    ) {
      return isBlockedIpv4Bytes(
        bytes[12].toInt() and 0xFF,
        bytes[13].toInt() and 0xFF,
        bytes[14].toInt() and 0xFF,
        bytes[15].toInt() and 0xFF,
      )
    }

    // Unique Local Address (fc00::/7)
    if ((b0 and 0xFE) == 0xFC) return true
    // Link-local (fe80::/10) and deprecated site-local (fec0::/10)
    if (b0 == 0xFE && (b1 and 0x80) == 0x80) return true
    // Multicast (ff00::/8)
    if (b0 == 0xFF) return true

    return false
  }

  private fun encodeUriComponent(value: String): String {
    val bytes = value.toByteArray(Charsets.UTF_8)
    val sb = StringBuilder(bytes.size * 2)
    for (rawByte in bytes) {
      val b = rawByte.toInt() and 0xFF
      if (isUnescapedUriComponentByte(b)) {
        sb.append(b.toChar())
      } else {
        sb.append('%')
        sb.append(HEX_DIGITS[(b ushr 4) and 0x0F])
        sb.append(HEX_DIGITS[b and 0x0F])
      }
    }
    return sb.toString()
  }

  private fun isUnescapedUriComponentByte(b: Int): Boolean {
    return (b in 'A'.code..'Z'.code) ||
      (b in 'a'.code..'z'.code) ||
      (b in '0'.code..'9'.code) ||
      b == '-'.code ||
      b == '_'.code ||
      b == '.'.code ||
      b == '!'.code ||
      b == '~'.code ||
      b == '*'.code ||
      b == '\''.code ||
      b == '('.code ||
      b == ')'.code
  }
}

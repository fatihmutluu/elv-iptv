package io.github.fatihmutluu.elv.media3

private val HLS_FAIL_AT_ONCE = setOf(401, 403, 407, 410, 429, 451, 509) + PANEL_LIMIT_STATUSES

/**
 * Whether a failed load skips Media3's own retries and reaches the playback service at once. [refused] requests
 * (provider notices, superseded media, an HLS body on a non-HLS guess, an initial empty response) always do. An HTTP
 * [responseCode] does on progressive media, where one connection is the whole stream, and on HLS until the first
 * manifest loaded; after that HLS segments and playlist refreshes keep Media3's retries except for auth, terminal
 * removal and connection-limit statuses, so one 404 or 5xx segment does not end a live stream. I/O errors without a
 * status keep the retries.
 */
fun failsAtOnce(responseCode: Int?, refused: Boolean, hls: Boolean, manifestLoaded: Boolean): Boolean =
  when {
    refused -> true
    responseCode == null -> false
    !hls || !manifestLoaded -> true
    else -> responseCode in HLS_FAIL_AT_ONCE
  }

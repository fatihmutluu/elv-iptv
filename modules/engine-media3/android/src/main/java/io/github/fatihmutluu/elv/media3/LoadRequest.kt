package io.github.fatihmutluu.elv.media3

/** Initial subtitle track preference carried on a `LoadCommand`. */
internal sealed interface SubtitlePreference {
  /** Leave Media3's default subtitle track selection untouched. */
  data object Default : SubtitlePreference

  /** Explicitly disable `C.TRACK_TYPE_TEXT` (`subtitleTrackId === null`). */
  data object Off : SubtitlePreference

  /** Select a specific subtitle track ID (falling back by language/label if reloaded groups shift). */
  data class Selected(val id: String) : SubtitlePreference
}

/** One `load`: what to play and how. Built from the JavaScript `LoadCommand`; never persisted. */
internal data class LoadRequest(
  val url: String,
  val headers: Map<String, String>,
  val live: Boolean,
  val startMs: Long?,
  val softwareAudio: Boolean,
  val preferHevcOverDolbyVision: Boolean = false,
  val audioTrackId: String? = null,
  val subtitlePreference: SubtitlePreference = SubtitlePreference.Default,
  /** The response to [url] was an HLS playlist (after redirects); the media is prepared as HLS from [url]. */
  val playlistDetected: Boolean = false,
  /** User-selected buffer size preset (#147). */
  val bufferPreset: BufferPreset = BufferPreset.AUTO,
) {
  /** Names no URL and no header value: both may carry credentials. */
  override fun toString(): String {
    val dvSuffix = if (preferHevcOverDolbyVision) ", preferHevcOverDolbyVision=true" else ""
    val presetSuffix = if (bufferPreset != BufferPreset.AUTO) ", bufferPreset=${bufferPreset.wireName}" else ""
    return "LoadRequest(live=$live, startMs=$startMs, softwareAudio=$softwareAudio, " +
      "playlistDetected=$playlistDetected, headers=${headers.size}$dvSuffix$presetSuffix)"
  }
}

/**
 * Parses the flattened JavaScript `load` map while preserving the three-way distinction between an omitted
 * `subtitleTrackId` ([SubtitlePreference.Default]), `null` ([SubtitlePreference.Off]), and a track id string
 * ([SubtitlePreference.Selected]).
 */
internal fun parseLoadArgs(args: Map<String, Any?>): Pair<Int, LoadRequest> {
  val attempt = (args["attempt"] as? Number)?.toInt() ?: 0
  val url = args["url"] as? String ?: ""
  val rawHeaders = args["headers"] as? Map<*, *>
  val headers =
    rawHeaders
      ?.entries
      ?.mapNotNull { (k, v) -> if (k is String && v is String) k to v else null }
      ?.toMap()
      ?: emptyMap()
  val kind = args["kind"] as? String ?: "live"
  val startMs = finiteLongOrNull(args["startMs"])
  val softwareAudio = args["softwareAudio"] as? Boolean ?: false
  val preferHevcOverDolbyVision = args["preferHevcOverDolbyVision"] as? Boolean ?: false
  val audioTrackId = (args["audioTrackId"] as? String)?.takeIf { it.isNotEmpty() }
  val bufferPreset = parseBufferPreset(args["bufferPreset"] as? String)
  val subtitlePreference =
    if (!args.containsKey("subtitleTrackId")) {
      SubtitlePreference.Default
    } else {
      when (val sub = args["subtitleTrackId"]) {
        null -> SubtitlePreference.Off
        is String -> if (sub.isNotEmpty()) SubtitlePreference.Selected(sub) else SubtitlePreference.Default
        else -> SubtitlePreference.Default
      }
    }
  return attempt to LoadRequest(
    url = url,
    headers = headers,
    live = kind != "vod",
    startMs = startMs,
    softwareAudio = softwareAudio,
    preferHevcOverDolbyVision = preferHevcOverDolbyVision,
    audioTrackId = audioTrackId,
    subtitlePreference = subtitlePreference,
    bufferPreset = bufferPreset,
  )
}

/**
 * The same request played as HLS. It keeps the original [LoadRequest.url]: Media3 follows the redirect again on every
 * playlist load and resolves segments against the redirected playlist, so a short-lived redirect token never expires
 * under a later `retry`.
 */
internal fun LoadRequest.asDetectedPlaylist(): LoadRequest = copy(playlistDetected = true)

/** How this request is played: see [sourceTypeFor]. */
internal fun LoadRequest.sourceType(): SourceType = sourceTypeFor(url, live, playlistDetected)

/** Stream buffer profile classification for [loadControlForStream] (#147). */
internal fun LoadRequest.streamKind(): StreamKind =
  if (!live) {
    StreamKind.VOD
  } else if (sourceType() == SourceType.TS) {
    StreamKind.RAW_TS_LIVE
  } else {
    StreamKind.HLS_LIVE
  }

private fun finiteLongOrNull(raw: Any?): Long? =
  when (raw) {
    is Double -> if (raw.isFinite()) raw.toLong() else null
    is Float -> if (raw.isFinite()) raw.toLong() else null
    is Number -> raw.toLong()
    else -> null
  }

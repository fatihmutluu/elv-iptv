package io.github.fatihmutluu.elv.media3

/** One `load`: what to play and how. Built from the JavaScript `LoadCommand`; never persisted. */
internal data class LoadRequest(
  val url: String,
  val headers: Map<String, String>,
  val live: Boolean,
  val startMs: Long?,
  val softwareAudio: Boolean,
  /** The response to [url] was an HLS playlist (after redirects); the media is prepared as HLS from [url]. */
  val playlistDetected: Boolean = false,
)

/**
 * The same request played as HLS. It keeps the original [LoadRequest.url]: Media3 follows the redirect again on every
 * playlist load and resolves segments against the redirected playlist, so a short-lived redirect token never expires
 * under a later `retry`.
 */
internal fun LoadRequest.asDetectedPlaylist(): LoadRequest = copy(playlistDetected = true)

/** How this request is played: see [sourceTypeFor]. */
internal fun LoadRequest.sourceType(): SourceType = sourceTypeFor(url, live, playlistDetected)

package io.github.fatihmutluu.elv.media3

/**
 * Thread-safe FIFO command-epoch, attempt-token, and rebuild state machine bridging Expo JSI calls to the
 * `ElvMedia3` playback looper, mirroring Apple's `CommandFence`.
 */
internal class CommandFence {
  sealed class MediaAction {
    data object Superseded : MediaAction()
    data class Run(val epoch: Int, val rebuildFirst: Boolean, val request: LoadRequest?) : MediaAction()
  }

  sealed class RecreateAction {
    data object Superseded : RecreateAction()
    data class Run(val epoch: Int) : RecreateAction()
  }

  private val lock = Any()
  private var disposed = false
  private var mediaEpoch = 0
  private var token = 0
  private var pendingRebuild = false
  private var pendingRequest: LoadRequest? = null

  val isDisposedNow: Boolean
    get() = synchronized(lock) { disposed }

  /** Records a JS `load` command, advancing `mediaEpoch` while preserving any unconsumed `recreate` request. */
  fun recordLoad(attempt: Int, request: LoadRequest): Int? = synchronized(lock) {
    if (disposed) return@synchronized null
    mediaEpoch += 1
    token = attempt
    pendingRequest = request
    mediaEpoch
  }

  /** Records a JS `retry` command, advancing `mediaEpoch` while adopting a newer `attempt` token. */
  fun recordRetry(attempt: Int): Int? = synchronized(lock) {
    if (disposed) return@synchronized null
    mediaEpoch += 1
    if (attempt > token) token = attempt
    mediaEpoch
  }

  /** Records an in-epoch command (`play`, `pause`, `seek`, `selectAudioTrack`, `selectSubtitleTrack`). */
  fun recordInEpochCommand(attempt: Int): Int? = synchronized(lock) {
    if (disposed) return@synchronized null
    if (attempt > token) token = attempt
    mediaEpoch
  }

  /** Records a JS `stop` command, advancing `mediaEpoch` to cancel superseded loads and clear pending media. */
  fun recordStop(attempt: Int): Int? = synchronized(lock) {
    if (disposed) return@synchronized null
    mediaEpoch += 1
    if (attempt > token) token = attempt
    pendingRequest = null
    mediaEpoch
  }

  /** Records a JS `recreate` command, arming `pendingRebuild` until executed by `recreate` or the next active `load`/`retry`. */
  fun recordRecreate(attempt: Int): Int? = synchronized(lock) {
    if (disposed) return@synchronized null
    mediaEpoch += 1
    if (attempt > token) token = attempt
    pendingRebuild = true
    mediaEpoch
  }

  /** Marks the engine permanently disposed; returns `true` only on the first call. */
  fun markDisposed(): Boolean = synchronized(lock) {
    if (disposed) return@synchronized false
    disposed = true
    mediaEpoch += 1
    pendingRebuild = false
    pendingRequest = null
    true
  }

  /** Evaluates whether a queued `load` or `retry` for [epoch] should run on the playback looper, consuming `pendingRebuild`. */
  fun beginMedia(epoch: Int): MediaAction = synchronized(lock) {
    if (disposed || mediaEpoch != epoch) return@synchronized MediaAction.Superseded
    val rebuildFirst = pendingRebuild
    pendingRebuild = false
    MediaAction.Run(epoch = epoch, rebuildFirst = rebuildFirst, request = pendingRequest)
  }

  /** Returns `true` when an in-epoch command queued for [epoch] still belongs to the active `mediaEpoch`. */
  fun beginInEpoch(epoch: Int): Boolean = synchronized(lock) {
    !disposed && mediaEpoch == epoch
  }

  /** Returns `true` when a queued `stop` may execute (not yet disposed). */
  fun canRunStop(): Boolean = synchronized(lock) { !disposed }

  /** Evaluates a standalone `recreate` block on the playback looper; defers to a newer queued `load`/`retry` when superseded. */
  fun beginRecreate(epoch: Int): RecreateAction = synchronized(lock) {
    if (disposed || mediaEpoch != epoch || !pendingRebuild) return@synchronized RecreateAction.Superseded
    pendingRebuild = false
    RecreateAction.Run(epoch = epoch)
  }

  /**
   * Filters and stamps outbound event tokens before emitting to JavaScript.
   * `surface` always adopts the latest token; `tracks` fences on `mediaEpoch` and adopts the latest in-epoch token
   * so `pause`/`play`/`seek` never drop deduplicated track snapshots; all other events require both `mediaEpoch` and `token`.
   */
  fun filterOutboundToken(eventType: String?, driverEpoch: Int, driverToken: Int): Int? {
    val snapDisposed: Boolean
    val snapEpoch: Int
    val snapToken: Int
    synchronized(lock) {
      snapDisposed = disposed
      snapEpoch = mediaEpoch
      snapToken = token
    }
    if (snapDisposed) return null
    return when (eventType) {
      "surface" -> snapToken
      "tracks", "mediaInfo", "telemetry" -> if (driverEpoch == snapEpoch) snapToken else null
      else -> if (driverEpoch == snapEpoch && driverToken == snapToken) driverToken else null
    }
  }
}

package io.github.fatihmutluu.elv.media3

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import java.util.Locale
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicInteger

/** Typed playback metadata published from JS onto Android's active `MediaSession` (#412). */
internal data class MediaSessionMetadataPayload(
  val title: String,
  val subtitle: String? = null,
  val artworkUrl: String? = null,
  val isLive: Boolean = true,
  val canStepTrack: Boolean = false,
)

/** Parses JS `setMediaMetadata(args)` maps into a [MediaSessionMetadataPayload], or `null` when cleared/blank. */
internal fun parseMediaMetadataArgs(args: Map<String, Any?>?): MediaSessionMetadataPayload? {
  if (args == null) return null
  val title = (args["title"] as? String)?.trim().orEmpty()
  if (title.isEmpty()) return null
  val subtitle = (args["subtitle"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
  val artworkUrl = (args["artworkUrl"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
  val kind = (args["kind"] as? String)?.trim()?.lowercase(Locale.ROOT)
  val isLive = kind != "vod"
  val canStepTrack = args["canStepTrack"] as? Boolean ?: false
  return MediaSessionMetadataPayload(
    title = title,
    subtitle = subtitle,
    artworkUrl = artworkUrl,
    isLive = isLive,
    canStepTrack = canStepTrack,
  )
}

/** Builds a Media3 [MediaMetadata] with credential-free artwork URI from [payload]. */
internal fun buildSessionMediaMetadata(payload: MediaSessionMetadataPayload?): MediaMetadata {
  if (payload == null) return MediaMetadata.EMPTY
  val builder = MediaMetadata.Builder()
    .setTitle(payload.title)
    .setDisplayTitle(payload.title)
  if (payload.subtitle != null) {
    builder.setSubtitle(payload.subtitle)
    builder.setArtist(payload.subtitle)
  }
  val safeArtwork = SessionCallbackPolicy.sanitizeArtworkUri(payload.artworkUrl)
  if (safeArtwork != null) {
    builder.setArtworkUri(safeArtwork)
  }
  return builder.build()
}

/** Abstraction over [ElvPlaybackSessionService] lifecycle calls so unit tests can verify start/stop transitions. */
internal interface PlaybackServiceBridge {
  fun start(context: Context)
  fun stop(context: Context)
}

internal object DefaultPlaybackServiceBridge : PlaybackServiceBridge {
  override fun start(context: Context) = ElvPlaybackSessionService.startSafely(context)
  override fun stop(context: Context) = ElvPlaybackSessionService.stopSafely(context)
}

/**
 * Thin [ForwardingPlayer] owned by [MediaSessionController] on `Media3Engine`'s playback looper:
 * - exposes `title`, `subtitle`/`artist`, and sanitized `artworkUri` via [getMediaMetadata];
 * - advertises next/previous stepping commands only when `canStepTrack == true` and routes `seekToNext*` /
 *   `seekToPrevious*` to JS via [onRemoteMediaAction] (`"next"` / `"previous"`);
 * - intercepts external `COMMAND_STOP` via [onRemoteStop] so engine, session, and JS stay synchronized.
 */
@OptIn(UnstableApi::class)
internal class SessionForwardingPlayer(
  player: Player,
  private val metadataProvider: () -> MediaMetadata,
  private val canStepTrackProvider: () -> Boolean,
  private val onRemoteMediaAction: (String) -> Unit,
  private val onRemoteStop: () -> Unit,
) : ForwardingPlayer(player) {
  private val sessionListeners = CopyOnWriteArraySet<Player.Listener>()

  override fun addListener(listener: Player.Listener) {
    sessionListeners.add(listener)
    super.addListener(listener)
  }

  override fun removeListener(listener: Player.Listener) {
    sessionListeners.remove(listener)
    super.removeListener(listener)
  }

  override fun getAvailableCommands(): Player.Commands {
    val base = super.getAvailableCommands()
    if (!canStepTrackProvider()) return base
    return base.buildUpon()
      .add(Player.COMMAND_SEEK_TO_NEXT)
      .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS)
      .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
      .build()
  }

  override fun isCommandAvailable(command: Int): Boolean {
    if (canStepTrackProvider() && isStepCommand(command)) return true
    return super.isCommandAvailable(command)
  }

  override fun hasNextMediaItem(): Boolean =
    canStepTrackProvider() || super.hasNextMediaItem()

  override fun hasPreviousMediaItem(): Boolean =
    canStepTrackProvider() || super.hasPreviousMediaItem()

  override fun getMediaMetadata(): MediaMetadata {
    val custom = metadataProvider()
    return if (custom != MediaMetadata.EMPTY) custom else super.getMediaMetadata()
  }

  override fun seekToNext() {
    if (canStepTrackProvider()) onRemoteMediaAction(ACTION_NEXT) else super.seekToNext()
  }

  override fun seekToNextMediaItem() {
    if (canStepTrackProvider()) onRemoteMediaAction(ACTION_NEXT) else super.seekToNextMediaItem()
  }

  override fun seekToPrevious() {
    if (canStepTrackProvider()) onRemoteMediaAction(ACTION_PREVIOUS) else super.seekToPrevious()
  }

  override fun seekToPreviousMediaItem() {
    if (canStepTrackProvider()) onRemoteMediaAction(ACTION_PREVIOUS) else super.seekToPreviousMediaItem()
  }

  override fun stop() {
    onRemoteStop()
  }

  fun notifyMetadataAndCommandsChanged() {
    val metadata = getMediaMetadata()
    val commands = getAvailableCommands()
    for (listener in sessionListeners) {
      listener.onMediaMetadataChanged(metadata)
      listener.onAvailableCommandsChanged(commands)
    }
  }

  companion object {
    const val ACTION_NEXT: String = "next"
    const val ACTION_PREVIOUS: String = "previous"
    const val ACTION_STOP: String = "stop"

    private fun isStepCommand(command: Int): Boolean =
      command == Player.COMMAND_SEEK_TO_NEXT ||
        command == Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM ||
        command == Player.COMMAND_SEEK_TO_PREVIOUS ||
        command == Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM
  }
}

/**
 * Manages the Android Media3 `MediaSession` and [ElvPlaybackSessionService] strictly on `Media3Engine`'s dedicated
 * playback looper (`HandlerThread("ElvMedia3").looper`, #412, #132):
 * - creates the session on `load()` / `play()` and starts [ElvPlaybackSessionService] via `context.startService(...)`
 *   so Media3's `MediaNotificationManager` promotes foreground state atomically;
 * - seamlessly swaps the underlying `ExoPlayer` via `mediaSession.setPlayer(...)` across `buildPlayer()` rebuilds
 *   without dropping notifications;
 * - preserves metadata across `onPlaybackStopped()` for background/error resume, clearing it on explicit
 *   `setMediaMetadata(null)` or `dispose()`.
 */
@OptIn(UnstableApi::class)
internal class MediaSessionController(
  private val context: Context,
  private val onRemoteMediaAction: (String) -> Unit,
  private val onTaskRemovedStop: () -> Unit,
  private val onRemoteStop: () -> Unit = {},
  private val serviceBridge: PlaybackServiceBridge = DefaultPlaybackServiceBridge,
  private val sessionFactory: (Context, String, Player, MediaSession.Callback) -> MediaSession =
    { ctx, id, player, callback ->
      MediaSession.Builder(ctx, player)
        .setId(id)
        .setCallback(callback)
        .build()
    },
) {
  private var currentPlayer: Player? = null
  private var forwardingPlayer: SessionForwardingPlayer? = null
  private var mediaSession: MediaSession? = null
  private var metadataPayload: MediaSessionMetadataPayload? = null
  private var mediaMetadata: MediaMetadata = MediaMetadata.EMPTY
  private var serviceStarted = false
  private var disposed = false

  internal val activeSessionForTest: MediaSession? get() = mediaSession
  internal val activeForwardingPlayerForTest: SessionForwardingPlayer? get() = forwardingPlayer

  /** Binds a newly created/rebuilt `ExoPlayer`, calling `mediaSession.setPlayer(...)` seamlessly when active. */
  fun onPlayerChanged(player: Player) {
    if (disposed) return
    currentPlayer = player
    val wrapped = wrapPlayer(player)
    forwardingPlayer = wrapped
    mediaSession?.setPlayer(wrapped)
  }

  /** Ensures the `MediaSession` is live and starts [ElvPlaybackSessionService] safely. */
  fun onPlaybackActive() {
    if (disposed) return
    val wrapped = forwardingPlayer ?: currentPlayer?.let { wrapPlayer(it).also { fp -> forwardingPlayer = fp } } ?: return
    if (mediaSession == null) {
      val id = "elv-media3-${SESSION_IDS.incrementAndGet()}"
      val callback = ElvMediaSessionCallback(context.packageName)
      val session = sessionFactory(context, id, wrapped, callback)
      mediaSession = session
      ElvPlaybackSessionService.registerSession(session, onTaskRemovedStop)
    }
    if (!serviceStarted) {
      serviceStarted = true
      serviceBridge.start(context)
    }
  }

  /** Updates lock-screen / Bluetooth metadata and next/previous track stepping capability. */
  fun setMediaMetadata(payload: MediaSessionMetadataPayload?) {
    if (disposed) return
    metadataPayload = payload
    mediaMetadata = buildSessionMediaMetadata(payload)
    forwardingPlayer?.notifyMetadataAndCommandsChanged()
  }

  /** Updates opt-in background audio playback policy read by [ElvPlaybackSessionService.onTaskRemoved]. */
  fun setBackgroundAudioEnabled(enabled: Boolean) {
    ElvPlaybackSessionService.setBackgroundAudioEnabled(enabled)
  }

  /** Updates the thread-safe actively-playing flag read by [ElvPlaybackSessionService.onTaskRemoved]. */
  fun updatePlayingState(isPlaying: Boolean) {
    val session = mediaSession ?: return
    if (ElvPlaybackSessionService.activeSession() === session) {
      ElvPlaybackSessionService.setSessionActivelyPlaying(isPlaying)
    }
  }

  /** Stops [ElvPlaybackSessionService] and releases the active `MediaSession` while preserving metadata for resume. */
  fun onPlaybackStopped() {
    val session = mediaSession
    mediaSession = null
    if (session != null) {
      ElvPlaybackSessionService.unregisterSession(session)
      runCatching { session.release() }
    }
    if (serviceStarted) {
      serviceStarted = false
      if (ElvPlaybackSessionService.activeSession() == null) {
        serviceBridge.stop(context)
      }
    }
  }

  /** Detaches the bound player and stops any active `MediaSession` (e.g. Multi-View demotion, `#34`). */
  fun detachPlayer() {
    onPlaybackStopped()
    currentPlayer = null
    forwardingPlayer = null
  }

  /** Permanently clears metadata, releases the session, and prevents future session creation. */
  fun dispose() {
    disposed = true
    metadataPayload = null
    mediaMetadata = MediaMetadata.EMPTY
    onPlaybackStopped()
    currentPlayer = null
    forwardingPlayer = null
  }

  private fun wrapPlayer(player: Player): SessionForwardingPlayer =
    SessionForwardingPlayer(
      player = player,
      metadataProvider = { mediaMetadata },
      canStepTrackProvider = { metadataPayload?.canStepTrack == true },
      onRemoteMediaAction = onRemoteMediaAction,
      onRemoteStop = onRemoteStop,
    )

  private companion object {
    private val SESSION_IDS = AtomicInteger(0)
  }
}

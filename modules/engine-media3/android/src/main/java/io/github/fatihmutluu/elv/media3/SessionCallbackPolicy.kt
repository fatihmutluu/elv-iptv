package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommands
import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Pure policy helpers for Media3 `MediaSession.Callback` command authorization (#132) and credential-free lock-screen
 * artwork sanitization (#412).
 */
@OptIn(UnstableApi::class)
internal object SessionCallbackPolicy {
  private val SENSITIVE_QUERY_KEYS: Set<String> = setOf(
    "password",
    "pass",
    "token",
    "auth",
    "key",
    "username",
    "user",
  )

  /**
   * Strictly bounded playback transport and read commands granted to untrusted external controllers (Bluetooth,
   * wearables, third-party media widgets): blocks queue/media-item/track-selection/playlist mutations.
   */
  val UNTRUSTED_PLAYER_COMMANDS: Player.Commands = Player.Commands.Builder()
    .add(Player.COMMAND_PLAY_PAUSE)
    .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
    .add(Player.COMMAND_SEEK_BACK)
    .add(Player.COMMAND_SEEK_FORWARD)
    .add(Player.COMMAND_SEEK_TO_PREVIOUS)
    .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    .add(Player.COMMAND_SEEK_TO_NEXT)
    .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    .add(Player.COMMAND_STOP)
    .add(Player.COMMAND_GET_CURRENT_MEDIA_ITEM)
    .add(Player.COMMAND_GET_METADATA)
    .build()

  /**
   * Notification and system controller commands: adds read-only playback inspection (`TIMELINE`, `TRACKS`,
   * `AUDIO_ATTRIBUTES`, `VOLUME`, `DEVICE_VOLUME`, `PREPARE`) needed for `MediaStyle` notifications while still
   * disallowing media-item, queue, and track-selection mutations.
   */
  val NOTIFICATION_PLAYER_COMMANDS: Player.Commands = UNTRUSTED_PLAYER_COMMANDS.buildUpon()
    .add(Player.COMMAND_PREPARE)
    .add(Player.COMMAND_GET_TIMELINE)
    .add(Player.COMMAND_GET_TRACKS)
    .add(Player.COMMAND_GET_AUDIO_ATTRIBUTES)
    .add(Player.COMMAND_GET_VOLUME)
    .add(Player.COMMAND_GET_DEVICE_VOLUME)
    .build()

  /**
   * Resolves the `MediaSession.ConnectionResult` for a connecting controller. Untrusted external controllers receive
   * [SessionCommands.EMPTY] and [UNTRUSTED_PLAYER_COMMANDS]; Media3's own notification/system controller receives
   * [MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS] and [NOTIFICATION_PLAYER_COMMANDS].
   */
  fun resolveConnectionResult(isNotificationOrSystemController: Boolean): MediaSession.ConnectionResult =
    if (isNotificationOrSystemController) {
      MediaSession.ConnectionResult.accept(
        MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS,
        NOTIFICATION_PLAYER_COMMANDS,
      )
    } else {
      MediaSession.ConnectionResult.accept(
        SessionCommands.EMPTY,
        UNTRUSTED_PLAYER_COMMANDS,
      )
    }

  /**
   * Sanitizes an artwork URL before publishing it to Android lock-screen notifications:
   * - rejects non-`http`/`https` schemes, control characters, and missing hosts;
   * - strips any `user:pass@` userinfo;
   * - strips credential query parameters (`password`, `pass`, `token`, `auth`, `key`, `username`, `user`).
   */
  fun sanitizeArtworkUri(url: String?): Uri? {
    if (url.isNullOrBlank()) return null
    if (url.any { it.code <= 0x1f || it.code == 0x7f }) return null
    val trimmed = url.trim()
    val schemeEnd = trimmed.indexOf("://")
    if (schemeEnd <= 0) return null
    val scheme = trimmed.substring(0, schemeEnd).lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") return null
    val afterScheme = trimmed.substring(schemeEnd + 3)
    if (afterScheme.isEmpty() || afterScheme[0] == '/' || afterScheme[0] == '\\') return null
    val parsed = trimmed.toHttpUrlOrNull() ?: return null
    if ((parsed.scheme != "http" && parsed.scheme != "https") || parsed.host.isEmpty()) return null

    val builder = parsed.newBuilder()
      .username("")
      .password("")
      .query(null)
    for (i in 0 until parsed.querySize) {
      val name = parsed.queryParameterName(i)
      if (name.lowercase(Locale.ROOT) !in SENSITIVE_QUERY_KEYS) {
        builder.addQueryParameter(name, parsed.queryParameterValue(i))
      }
    }
    return Uri.parse(builder.build().toString())
  }
}

/**
 * `MediaSession.Callback` enforcing [SessionCallbackPolicy] for every connecting controller (#132).
 */
@OptIn(UnstableApi::class)
internal class ElvMediaSessionCallback(
  private val ownPackageName: String,
) : MediaSession.Callback {
  override fun onConnect(
    session: MediaSession,
    controller: MediaSession.ControllerInfo,
  ): MediaSession.ConnectionResult {
    val isNotificationOrSystem =
      session.isMediaNotificationController(controller) || controller.packageName == ownPackageName
    return SessionCallbackPolicy.resolveConnectionResult(isNotificationOrSystem)
  }
}

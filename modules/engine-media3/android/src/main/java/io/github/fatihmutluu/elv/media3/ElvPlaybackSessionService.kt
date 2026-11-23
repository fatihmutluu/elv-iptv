package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Foreground `MediaSessionService` (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`) backing Android lock-screen, notification
 * shade, and Bluetooth media controls (#412). Attaches the active `MediaSession` owned by [MediaSessionController]
 * via [addSession] so Media3's `MediaNotificationManager` promotes and demotes foreground state atomically, and
 * stops playback on `onTaskRemoved` unless opt-in background audio playback is enabled and the player is playing.
 */
@OptIn(UnstableApi::class)
class ElvPlaybackSessionService : MediaSessionService() {
  override fun onCreate() {
    super.onCreate()
    serviceRef.set(WeakReference(this))
    attachActiveSessionIfPresent()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    serviceRef.set(WeakReference(this))
    attachActiveSessionIfPresent()
    if (activeSession() == null && sessions.isEmpty()) {
      stopSelf()
      return START_NOT_STICKY
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun onDestroy() {
    val current = serviceRef.get()
    if (current?.get() === this || current?.get() == null) {
      serviceRef.compareAndSet(current, null)
    }
    super.onDestroy()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
    activeSession()

  override fun onTaskRemoved(rootIntent: Intent?) {
    val keepAlive = shouldKeepAliveOnTaskRemoved(
      backgroundEnabled = backgroundAudioEnabled.get(),
      isPlaying = activeSession() != null && sessionActivelyPlaying.get(),
    )
    if (!keepAlive) {
      onTaskRemovedStopCallback.get()?.invoke()
      stopSelf()
    }
  }

  private fun attachActiveSessionIfPresent() {
    val session = activeSession() ?: return
    if (!isSessionAdded(session)) {
      runCatching { addSession(session) }
    }
  }

  internal companion object {
    private val serviceRef = AtomicReference<WeakReference<ElvPlaybackSessionService>?>(null)
    private val sessionRef = AtomicReference<WeakReference<MediaSession>?>(null)
    private val backgroundAudioEnabled = AtomicBoolean(false)
    private val sessionActivelyPlaying = AtomicBoolean(false)
    private val onTaskRemovedStopCallback = AtomicReference<(() -> Unit)?>(null)

    fun registerSession(session: MediaSession, onStopRequested: () -> Unit) {
      sessionRef.set(WeakReference(session))
      onTaskRemovedStopCallback.set(onStopRequested)
      val service = serviceRef.get()?.get() ?: return
      Handler(Looper.getMainLooper()).post {
        if (activeSession() === session && !service.isSessionAdded(session)) {
          runCatching { service.addSession(session) }
        }
      }
    }

    fun unregisterSession(session: MediaSession) {
      val current = sessionRef.get()
      if (current?.get() === session || current?.get() == null) {
        sessionRef.compareAndSet(current, null)
        sessionActivelyPlaying.set(false)
        onTaskRemovedStopCallback.set(null)
      }
      val service = serviceRef.get()?.get() ?: return
      if (service.isSessionAdded(session)) {
        runCatching { service.removeSession(session) }
      }
      Handler(Looper.getMainLooper()).post {
        if (service.isSessionAdded(session)) {
          runCatching { service.removeSession(session) }
        }
      }
    }

    fun activeSession(): MediaSession? = sessionRef.get()?.get()

    fun setBackgroundAudioEnabled(enabled: Boolean) {
      backgroundAudioEnabled.set(enabled)
    }

    fun isBackgroundAudioEnabled(): Boolean = backgroundAudioEnabled.get()

    fun setSessionActivelyPlaying(playing: Boolean) {
      sessionActivelyPlaying.set(playing)
    }

    fun shouldKeepAliveOnTaskRemoved(backgroundEnabled: Boolean, isPlaying: Boolean): Boolean =
      backgroundEnabled && isPlaying

    fun startSafely(context: Context) {
      val intent = Intent(context, ElvPlaybackSessionService::class.java)
      try {
        context.startService(intent)
      } catch (_: IllegalStateException) {
        // Android 8+ throws IllegalStateException when starting a background service without foreground
        // exemptions; fail open without crashing.
      } catch (_: SecurityException) {
        // Guard against restricted vendor or TV builds.
      }
    }

    fun stopSafely(context: Context) {
      val intent = Intent(context, ElvPlaybackSessionService::class.java)
      runCatching { context.stopService(intent) }
    }

    internal fun resetForTest() {
      serviceRef.set(null)
      sessionRef.set(null)
      backgroundAudioEnabled.set(false)
      sessionActivelyPlaying.set(false)
      onTaskRemovedStopCallback.set(null)
    }
  }
}

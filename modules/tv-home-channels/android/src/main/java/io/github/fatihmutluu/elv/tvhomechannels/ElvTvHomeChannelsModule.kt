package io.github.fatihmutluu.elv.tvhomechannels

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Expo native module exposing Android TV Home Screen Preview Channels (`#273`).
 * All TvProvider IPC and logo downloads run sequentially on a dedicated background executor so
 * the main/UI thread is never blocked.
 */
class ElvTvHomeChannelsModule : Module() {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "ElvTvHomeChannels").apply { isDaemon = true }
  }

  override fun definition() = ModuleDefinition {
    Name("ElvTvHomeChannels")

    Function("isSupported") {
      val context = appContext.reactContext ?: return@Function false
      TvChannelsSyncManager(context).isSupported()
    }

    AsyncFunction("syncChannels") { rawChannels: List<Map<String, Any?>>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(UNSUPPORTED_RESULT)
        return@AsyncFunction
      }
      val specs = parseChannelSpecs(rawChannels)
      try {
        executor.execute {
          try {
            val result = TvChannelsSyncManager(context).syncChannels(specs)
            promise.resolve(
              mapOf(
                "supported" to result.supported,
                "syncedChannels" to result.syncedChannels,
                "syncedPrograms" to result.syncedPrograms,
              ),
            )
          } catch (err: Exception) {
            promise.reject("ERR_TV_HOME_CHANNELS_SYNC", err.message ?: "Channel sync failed", err)
          }
        }
      } catch (_: RejectedExecutionException) {
        promise.resolve(UNSUPPORTED_RESULT)
      }
    }

    AsyncFunction("clearChannels") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      try {
        executor.execute {
          try {
            TvChannelsSyncManager(context).clearAllChannels()
            promise.resolve(null)
          } catch (err: Exception) {
            promise.reject("ERR_TV_HOME_CHANNELS_CLEAR", err.message ?: "Channel clear failed", err)
          }
        }
      } catch (_: RejectedExecutionException) {
        promise.resolve(null)
      }
    }

    OnDestroy {
      executor.shutdown()
    }
  }

  private fun parseChannelSpecs(rawChannels: List<Map<String, Any?>>): List<TvChannelSpec> {
    val out = ArrayList<TvChannelSpec>(minOf(rawChannels.size, TvChannelSecurity.MAX_CHANNELS))
    for (channelMap in rawChannels) {
      val internalId = channelMap["internalId"] as? String ?: continue
      val displayName = channelMap["displayName"] as? String ?: continue
      val isDefaultBrowsable = channelMap["isDefaultBrowsable"] as? Boolean ?: false
      val rawPrograms = (channelMap["programs"] as? List<*>) ?: emptyList<Any?>()
      val programs = ArrayList<TvProgramSpec>(minOf(rawPrograms.size, TvChannelSecurity.MAX_PROGRAMS_PER_CHANNEL))

      for (entry in rawPrograms) {
        val programMap = entry as? Map<*, *> ?: continue
        val itemKey = programMap["itemKey"] as? String ?: continue
        val title = programMap["title"] as? String ?: continue
        val kind = programMap["kind"] as? String ?: continue
        val subtitle = programMap["subtitle"] as? String
        val logoUrl = programMap["logoUrl"] as? String
        val durationMs = (programMap["durationMs"] as? Number)?.toLong()
        val lastPlaybackPositionMs = (programMap["lastPlaybackPositionMs"] as? Number)?.toLong()
        val isLive = programMap["isLive"] as? Boolean ?: false
        programs.add(
          TvProgramSpec(
            itemKey = itemKey,
            title = title,
            subtitle = subtitle,
            kind = kind,
            logoUrl = logoUrl,
            durationMs = durationMs,
            lastPlaybackPositionMs = lastPlaybackPositionMs,
            isLive = isLive,
          ),
        )
      }

      out.add(
        TvChannelSpec(
          internalId = internalId,
          displayName = displayName,
          isDefaultBrowsable = isDefaultBrowsable,
          programs = programs,
        ),
      )
    }
    return out
  }

  companion object {
    private val UNSUPPORTED_RESULT: Map<String, Any> = mapOf(
      "supported" to false,
      "syncedChannels" to 0,
      "syncedPrograms" to 0,
    )
  }
}

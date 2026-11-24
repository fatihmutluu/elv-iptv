package io.github.fatihmutluu.elv.tvhomechannels

import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.tvprovider.media.tv.Channel
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat

/** Result returned by [TvChannelsSyncManager.syncChannels]. */
data class TvHomeChannelsSyncResult(
  val supported: Boolean,
  val syncedChannels: Int,
  val syncedPrograms: Int,
)

/**
 * Publishes bounded Android TV Home Screen Preview Channels via `TvContractCompat` (`#273`).
 * Safely degrades on phones, non-Leanback builds, and Android `< API 26`, respects user channel
 * removal via `COLUMN_BROWSABLE` + SharedPreferences tombstones, and only writes `elviptv://play`
 * deep links.
 */
@SuppressLint("RestrictedApi")
class TvChannelsSyncManager(
  private val context: Context,
  private val logoCache: TvChannelLogoCache = TvChannelLogoCache(context),
) {
  private val prefs: SharedPreferences by lazy {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  }

  /** Returns true only on Android TV (API 26+ with `FEATURE_LEANBACK`). */
  fun isSupported(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
    return runCatching {
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    }.getOrDefault(false)
  }

  /**
   * Synchronizes up to 2 channels (`continue_watching`, `favorites`), max 20 programs each.
   * Must be called from a background thread.
   */
  fun syncChannels(rawChannels: List<TvChannelSpec>): TvHomeChannelsSyncResult {
    if (!isSupported()) {
      return TvHomeChannelsSyncResult(supported = false, syncedChannels = 0, syncedPrograms = 0)
    }

    val existingByInternalId = queryExistingChannels()
      ?: return TvHomeChannelsSyncResult(supported = false, syncedChannels = 0, syncedPrograms = 0)

    val channels = TvChannelSecurity.sanitizeChannels(rawChannels)
    var syncedChannels = 0
    var syncedPrograms = 0

    for (channel in channels) {
      val internalId = channel.internalId
      val existing = existingByInternalId[internalId]
      val decision = TvChannelSecurity.decideChannelSync(
        existingChannelExists = existing != null,
        existingBrowsable = existing?.browsable == true,
        wasCreatedBefore = prefs.getBoolean(keyCreated(internalId), false),
        wasBrowsableBefore = prefs.getBoolean(keyWasBrowsable(internalId), false),
        isRemovedTombstone = prefs.getBoolean(keyRemoved(internalId), false),
        isDefaultBrowsable = channel.isDefaultBrowsable,
        browsableAlreadyRequested = prefs.getBoolean(keyBrowsableRequested(internalId), false),
        hasPrograms = channel.programs.isNotEmpty(),
      )

      applyPreferenceFlags(internalId, decision)

      when (decision.action) {
        ChannelSyncAction.SKIP -> continue
        ChannelSyncAction.CREATE_CHANNEL -> {
          val channelId = insertChannel(channel) ?: continue
          prefs.edit().putBoolean(keyCreated(internalId), true).apply()
          if (decision.requestBrowsable) {
            runCatching { TvContractCompat.requestChannelBrowsable(context, channelId) }
            prefs.edit().putBoolean(keyBrowsableRequested(internalId), true).apply()
          }
          val insertedCount = replacePrograms(channelId, channel.programs)
          syncedChannels += 1
          syncedPrograms += insertedCount
        }
        ChannelSyncAction.UPDATE_PROGRAMS -> {
          val existingRow = existing ?: continue
          if (existingRow.displayName != channel.displayName) {
            updateChannelDisplayName(existingRow.id, channel.displayName)
          }
          val insertedCount = replacePrograms(existingRow.id, channel.programs)
          syncedChannels += 1
          syncedPrograms += insertedCount
        }
      }
    }

    return TvHomeChannelsSyncResult(
      supported = true,
      syncedChannels = syncedChannels,
      syncedPrograms = syncedPrograms,
    )
  }

  /** Deletes all app-owned channels from TvProvider and clears cached launcher logos. */
  fun clearAllChannels() {
    if (isSupported()) {
      val existing = queryAllAppChannels().orEmpty()
      for (row in existing) {
        runCatching {
          context.contentResolver.delete(TvContractCompat.buildChannelUri(row.id), null, null)
        }
      }
      // Reset creation tracking while preserving user-removal tombstones.
      val editor = prefs.edit()
      for (id in TvChannelSecurity.ALLOWED_CHANNEL_IDS) {
        editor.remove(keyCreated(id))
        editor.remove(keyWasBrowsable(id))
        editor.remove(keyBrowsableRequested(id))
      }
      editor.apply()
    }
    logoCache.clearCache()
  }

  private data class ExistingChannelRow(
    val id: Long,
    val internalId: String?,
    val displayName: String?,
    val browsable: Boolean,
  )

  private fun applyPreferenceFlags(internalId: String, decision: ChannelSyncDecision) {
    if (!decision.markRemovedTombstone && !decision.clearRemovedTombstone && !decision.markWasBrowsable) {
      return
    }
    val editor = prefs.edit()
    if (decision.markRemovedTombstone) editor.putBoolean(keyRemoved(internalId), true)
    if (decision.clearRemovedTombstone) editor.putBoolean(keyRemoved(internalId), false)
    if (decision.markWasBrowsable) editor.putBoolean(keyWasBrowsable(internalId), true)
    editor.apply()
  }

  private fun queryExistingChannels(): Map<String, ExistingChannelRow>? {
    val all = queryAllAppChannels() ?: return null
    val map = LinkedHashMap<String, ExistingChannelRow>()
    for (row in all) {
      val internalId = row.internalId ?: continue
      if (internalId in TvChannelSecurity.ALLOWED_CHANNEL_IDS) {
        map[internalId] = row
      }
    }
    return map
  }

  private fun queryAllAppChannels(): List<ExistingChannelRow>? {
    return try {
      val projection = arrayOf(
        TvContractCompat.Channels._ID,
        TvContractCompat.Channels.COLUMN_INTERNAL_PROVIDER_ID,
        TvContractCompat.Channels.COLUMN_DISPLAY_NAME,
        TvContractCompat.Channels.COLUMN_BROWSABLE,
      )
      val out = ArrayList<ExistingChannelRow>()
      context.contentResolver.query(
        TvContractCompat.Channels.CONTENT_URI,
        projection,
        null,
        null,
        null,
      )?.use { cursor ->
        val idIdx = cursor.getColumnIndex(TvContractCompat.Channels._ID)
        val internalIdx = cursor.getColumnIndex(TvContractCompat.Channels.COLUMN_INTERNAL_PROVIDER_ID)
        val nameIdx = cursor.getColumnIndex(TvContractCompat.Channels.COLUMN_DISPLAY_NAME)
        val browsableIdx = cursor.getColumnIndex(TvContractCompat.Channels.COLUMN_BROWSABLE)
        while (cursor.moveToNext()) {
          if (idIdx < 0) continue
          val id = cursor.getLong(idIdx)
          val internalId = if (internalIdx >= 0) cursor.getString(internalIdx) else null
          val displayName = if (nameIdx >= 0) cursor.getString(nameIdx) else null
          val browsable = browsableIdx >= 0 && cursor.getInt(browsableIdx) == 1
          out.add(ExistingChannelRow(id, internalId, displayName, browsable))
        }
      }
      out
    } catch (_: SecurityException) {
      null
    } catch (_: IllegalArgumentException) {
      null
    } catch (_: UnsupportedOperationException) {
      null
    }
  }

  private fun insertChannel(channel: TvChannelSpec): Long? {
    return try {
      val values = Channel.Builder()
        .setType(TvContractCompat.Channels.TYPE_PREVIEW)
        .setDisplayName(channel.displayName)
        .setAppLinkIntentUri(Uri.parse("${TvChannelSecurity.PLAY_DEEP_LINK_SCHEME}://"))
        .setInternalProviderId(channel.internalId)
        .build()
        .toContentValues()
      val uri = context.contentResolver.insert(TvContractCompat.Channels.CONTENT_URI, values)
        ?: return null
      val id = ContentUris.parseId(uri)
      if (id >= 0L) id else null
    } catch (_: Exception) {
      null
    }
  }

  private fun updateChannelDisplayName(channelId: Long, displayName: String) {
    runCatching {
      val values = ContentValues().apply {
        put(TvContractCompat.Channels.COLUMN_DISPLAY_NAME, displayName)
      }
      context.contentResolver.update(
        TvContractCompat.buildChannelUri(channelId),
        values,
        null,
        null,
      )
    }
  }

  private fun replacePrograms(channelId: Long, programs: List<TvProgramSpec>): Int {
    runCatching {
      context.contentResolver.delete(
        TvContractCompat.buildPreviewProgramsUriForChannel(channelId),
        null,
        null,
      )
    }

    val bounded = programs.take(TvChannelSecurity.MAX_PROGRAMS_PER_CHANNEL)
    var inserted = 0
    for ((index, program) in bounded.withIndex()) {
      val deepLink = runCatching {
        TvChannelSecurity.buildPlayDeepLinkUri(program.itemKey, program.kind)
      }.getOrNull() ?: continue

      val posterUri = program.logoUrl?.let { logoCache.resolveLogoUri(it) }
      val programType = when (program.kind) {
        "live" -> TvContractCompat.PreviewPrograms.TYPE_CHANNEL
        "movie" -> TvContractCompat.PreviewPrograms.TYPE_MOVIE
        else -> TvContractCompat.PreviewPrograms.TYPE_TV_EPISODE
      }
      val aspectRatio = if (program.kind == "movie") {
        TvContractCompat.PreviewPrograms.ASPECT_RATIO_2_3
      } else {
        TvContractCompat.PreviewPrograms.ASPECT_RATIO_16_9
      }

      val builder = PreviewProgram.Builder()
        .setChannelId(channelId)
        .setType(programType)
        .setTitle(program.title)
        .setInternalProviderId(program.itemKey)
        .setIntentUri(Uri.parse(deepLink))
        .setPosterArtAspectRatio(aspectRatio)
        .setLive(program.isLive || program.kind == "live")
        .setWeight(TvChannelSecurity.MAX_PROGRAMS_PER_CHANNEL - index)

      if (!program.subtitle.isNullOrBlank()) {
        builder.setDescription(program.subtitle)
      }
      if (posterUri != null) {
        builder.setPosterArtUri(posterUri)
      }
      if (program.durationMs != null && program.durationMs > 0L) {
        builder.setDurationMillis(program.durationMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
      }
      if (program.lastPlaybackPositionMs != null && program.lastPlaybackPositionMs >= 0L) {
        builder.setLastPlaybackPositionMillis(
          program.lastPlaybackPositionMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
        )
      }

      val uri = runCatching {
        context.contentResolver.insert(
          TvContractCompat.PreviewPrograms.CONTENT_URI,
          builder.build().toContentValues(),
        )
      }.getOrNull()
      if (uri != null) {
        inserted += 1
      }
    }
    return inserted
  }

  private fun keyCreated(internalId: String): String = "created_$internalId"
  private fun keyWasBrowsable(internalId: String): String = "was_browsable_$internalId"
  private fun keyRemoved(internalId: String): String = "removed_$internalId"
  private fun keyBrowsableRequested(internalId: String): String = "browsable_requested_$internalId"

  companion object {
    private const val PREFS_NAME = "elv_tv_home_channels_prefs"
  }
}

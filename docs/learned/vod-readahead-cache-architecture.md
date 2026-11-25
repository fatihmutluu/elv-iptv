# Adaptive VOD Read-Ahead and Ephemeral Back-Buffer Architecture (#350)

This note documents the clean-room architectural study behind ELV IPTV's adaptive VOD read-ahead and back-buffer caching subsystem across Android (Media3), Apple (AetherEngine / AVPlayer), and Desktop (`libmpv` / `mpv`).

## 1. Per-Engine Capabilities and Trade-Offs

| Engine | Forward Read-Ahead Mechanism | Back-Buffer Mechanism | Ephemeral Disk Spill | Key Platform Constraints |
| --- | --- | --- | --- | --- |
| **Android Media3** | `DefaultLoadControl` (`minBufferMs`, `maxBufferMs`, `targetBufferBytes`) + write-through `CacheDataSource` backed by bounded `SimpleCache` | `DefaultLoadControl.setBackBuffer(backBufferMs, retainBackBufferFromKeyframe = true)` + `SimpleCache` LRU blocks for older seeks | `SimpleCache` + `LeastRecentlyUsedCacheEvictor` under `context.cacheDir/vod-cache/<session>` | Must respect low-RAM (`< 1.5 GiB` or `isLowRamDevice`) `16 MiB` RAM cap (`prioritizeTimeOverSizeThresholds = false`); `SimpleCache.release()` must run off the main thread; `FLAG_IGNORE_CACHE_ON_ERROR` prevents `ENOSPC` crashes. |
| **Desktop `mpv`** | Single-demuxer `--demuxer-max-bytes` + adaptive `--demuxer-readahead-secs` + `--demuxer-hysteresis-secs` | `--demuxer-max-back-bytes` + seekable ranges retained in demuxer cache | Per-file `cache-on-disk=yes` + per-session `--demuxer-cache-dir=<ephemeral>` inside OS cache/temp dir | Strictly sandbox-safe directory (`app.getPath('cache')` / `tmpdir()`, never `/tmp` under macOS App Sandbox or synced `userData`); must reset to `cache-on-disk=no` on live streams; orphan cache dirs must be swept on startup and `stop()`/`quit`. |
| **Apple AetherEngine / AVPlayer** | `AVPlayerItem.preferredForwardBufferDuration` scaled by RAM tier & `BufferPreset` + `AetherEngine` single-connection reader (`maxConcurrentSourceRequests = 1`) | `AVPlayerItem` retained `loadedTimeRanges` behind `currentTime` + bounded FFmpeg demuxer window | OS-managed media pipeline (no separate parallel downloader); `URLSession` URL cache stays disabled so credentials never persist to `Cache.db` | tvOS and older iOS devices face strict `jetsam` limits; `preferredForwardBufferDuration` must stay conservative on `<= 3 GiB` devices and back off under memory/thermal pressure or `429`/`509`. |

## 2. IPTV Provider Constraints and Mitigations

1. **Strict `max_connections = 1` Compliance:**
   - Many IPTV providers enforce a single active stream connection per account and respond with HTTP `429`, `509`, `458`, or account lockouts if a player opens parallel HTTP connections for prefetching.
   - **Rule:** VOD read-ahead and disk caching MUST NEVER open a second concurrent HTTP connection alongside active playback. All cached bytes MUST be populated strictly write-through from the player's single active upstream socket (`CacheDataSource` wrapping the single gated `DataSource` on Media3, `mpv`'s single demuxer reader on Desktop, `maxConcurrentSourceRequests = 1` on Apple).
2. **Server Throttling (`429` / `509` / Repeated Rebuffer Backoff):**
   - Aggressive faster-than-realtime reads can trip provider rate limiters.
   - **Mitigation:** Track `throttleBackoffLevel` (0..3) triggered by HTTP `429` / `509` responses during VOD playback. Each backoff step halves forward read-ahead duration and memory/disk read-ahead ceilings down to a conservative real-time floor, and disables disk spill at backoff level `>= 2`.
3. **Short-Lived CDN Tokens and Privacy:**
   - Provider VOD URLs often contain credentials or expiring session tokens.
   - **Mitigation:** Ephemeral cache keys and filenames MUST use a cryptographic SHA-256 hex digest (or opaque per-session random ID)—never raw URLs, hostnames, query strings, or auth headers. Cached VOD data is strictly per-session and never reused across account/session boundaries.
4. **HTTP Range Support:**
   - Servers that reject or omit `Accept-Ranges` fall back seamlessly to sequential single-stream buffering without failing playback (`CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR` and `mpv` native range fallback).

## 3. Device Safety, Flash Endurance, and Cleanup Rules

- **RAM-First Bounding:** Low-RAM devices (`< 1.5 GiB` RAM or Android `isLowRamDevice`) strictly enforce a `<= 16 MiB` RAM buffer cap regardless of the user's `BufferPreset` (`auto` / `balanced` / `large`).
- **Free Storage Guard (`StatFs` / `statfs`):** Disk-backed VOD spill is enabled ONLY when available free disk space is `>= 512 MiB` and the active device is not in Multi-View mode. Maximum disk cache size is capped at `min(presetDiskCapBytes, floor(freeDiskBytes * 0.10))` and never exceeds `512 MiB` even on high-end desktops.
- **Deterministic Ephemeral Purge:** Every per-session VOD cache directory is deleted on `stop()`, item replacement (`load`), `recreate()`, `dispose()` / app quit, AND any crashed-session leftovers are swept at cold startup.

## 4. Strict Live vs. VOD Separation

- Adaptive forward read-ahead, back-buffer retention, and ephemeral disk spill apply **exclusively to `kind === 'vod'`**.
- Live streams (`kind === 'live'`, both raw MPEG-TS and live HLS) remain governed by real-time live `LoadControl` / `TimeShiftRingBuffer` (Android) and `cache-on-disk=no` live ring settings (Desktop) because future segments do not exist ahead of live edge.

## 5. Decision and Default Policy

Proceed with a unified cross-platform adaptive VOD buffer policy (`@elv/playback` `computeVodBufferBudget`, mirrored in Kotlin and Swift):
- **`auto` (default):** RAM-scaled forward target (`30s`–`120s`), back-buffer (`10s`–`30s`), ephemeral disk spill (`64 MiB`–`192 MiB` when free disk `>= 512 MiB`).
- **`balanced`:** Forward target (`45s`–`150s`), back-buffer (`15s`–`45s`), ephemeral disk spill (`96 MiB`–`256 MiB`).
- **`large`:** Forward target (`60s`–`240s`), back-buffer (`20s`–`60s`), ephemeral disk spill (`128 MiB`–`512 MiB`).
- Low-RAM devices (`< 1.5 GiB`) stay locked to safe RAM (`<= 16 MiB`) and small ephemeral disk spill (`<= 32 MiB`, disabled if `< 512 MiB` free).
- Live `BufferHealth` (`bufferedAheadMs`, `bufferedBehindMs`) is emitted on `ClockAnchor` and visualized subtly in `VodProgressBar` (Cinema Quietude v2) so users can see forward read-ahead and instant return-seek coverage without visual clutter.

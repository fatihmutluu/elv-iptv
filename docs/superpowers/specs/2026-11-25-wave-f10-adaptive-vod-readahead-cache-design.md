# Wave F10 Design Spec — Adaptive VOD Read-Ahead & Back-Buffer Cache (#350)

**Date:** 2026-11-25
**Issue:** #350 (Epic #347)
**Companion Study:** `docs/learned/vod-readahead-cache-architecture.md`

## 1. Goals & Non-Negotiable Invariants
1. **Instant-Scrub VOD Smoothness & Instant Return Seeks:** Scale forward read-ahead and backward return-seek cushions adaptively to `BufferPreset` (`auto | balanced | large`), device RAM tier, free disk space, and server throttling (`429`/`509`) across Android Media3, Desktop `mpv`, and Apple `AetherEngine`.
2. **Strict `max_connections = 1`:** Zero second concurrent HTTP connection during VOD read-ahead or disk caching (`overlapMs === 0`, `limitResponses === 0`). All disk caching is single-socket write-through.
3. **Strict VOD-Only Scope:** Live streams (`kind === 'live'`) never enable VOD disk spill or VOD forward read-ahead budgets (`allowDiskCache = false`, `backTargetMs = 0` for VOD planner).
4. **Device Safety & Ephemeral Privacy:**
   - Low-RAM Android/TV devices (`< 1.5 GiB` or `isLowRamDevice`) remain capped at `<= 16 MiB` RAM (`prioritizeTimeOverSizeThresholds = false`).
   - Disk cache requires `>= 512 MiB` free storage and caps at `min(presetCap, floor(freeDiskBytes * 0.10))`.
   - All cache keys/paths use SHA-256 hex digests or opaque session UUIDs — zero raw stream URLs, hostnames, or tokens on disk.
   - Per-session ephemeral cache directories are stored in OS sandbox-safe cache/temp dirs (compatible with macOS MAS App Sandbox, Windows MSIX, Android `cacheDir`, Apple `Caches`) and purged on `stop()`, item replace, `dispose()`, and startup orphan sweep.
5. **Cinema Quietude v2 UI:** Surface live `BufferHealth` (`bufferedAheadMs` + `bufferedBehindMs`) calmly inside `VodProgressBar` (subtle translucent cushion behind the primary fill and playhead) with zero flash or layout jitter.
6. **Zero A/V & Subtitle Drift Proof Gate:** Provide an automated VOD rapid-seek & back-buffer proof gate verifying single-connection discipline, cached return seeks (`0` extra upstream HTTP requests), cache cleanup, `429`/`509` backoff, and zero A/V/subtitle clock drift.

## 2. Shared Pure Contract (`@elv/playback`)
- **`packages/playback/src/vod-buffer-policy.ts`:**
  - `VodBufferBudgetInput`: `{ kind: MediaKind; bufferPreset?: BufferPreset; deviceRamBytes: number; isLowRamDevice?: boolean; freeDiskBytes?: number; multiViewTileCount?: number; throttleBackoffLevel?: number; estimatedBitrateBps?: number }`
  - `VodBufferBudget`: `{ enabled: boolean; forwardTargetMs: number; minBufferMs: number; backTargetMs: number; maxMemoryBytes: number; maxDiskBytes: number; allowDiskCache: boolean; throttleBackoffLevel: number; prioritizeTimeOverSize: boolean }`
  - Pure deterministic `computeVodBufferBudget(input)` + `nextThrottleBackoffLevel(current, httpStatus)` + `decayThrottleBackoffLevel(current, healthySeconds)` with `>= 90%` unit coverage.
  - Strict invariants:
    - `kind === 'live'` -> `{ enabled: false, allowDiskCache: false, maxDiskBytes: 0, ... }`.
    - `isLowRam` (`isLowRamDevice || deviceRamBytes < 1536 MiB`) -> `maxMemoryBytes <= 16 MiB`, `prioritizeTimeOverSize: false`.
    - `freeDiskBytes < 512 MiB` or `multiViewTileCount > 1` or `throttleBackoffLevel >= 2` -> `allowDiskCache: false`, `maxDiskBytes: 0`.
    - When `allowDiskCache` is true -> `maxDiskBytes <= Math.min(presetDiskCap, Math.floor(freeDiskBytes * 0.10))`.
- **`packages/playback/src/engine.ts` & `native-bridge.ts` & `service-events.ts`:**
  - Add `BufferHealth`: `{ readonly bufferedAheadMs: number; readonly bufferedBehindMs: number; readonly diskCacheBytes?: number; readonly throttled?: boolean }`.
  - Add optional `readonly bufferHealth?: BufferHealth` to `ClockAnchor`.
  - Sanitize `bufferHealth` in `native-bridge.ts` (`nonNegativeFinite` numbers, drop malformed fields) and preserve/merge `bufferHealth` cleanly in `service-events.ts` without breaking stale-seek clock filtering (`STALE_CLOCK_GUARD_MS`).

## 3. UI Visualization (`@elv/features`)
- **`packages/features/src/player/vod-progress-helpers.ts` & `VodProgressBar.tsx`:**
  - Extend `ProgressSnapshot` with `bufferedStartPercent` (`0..100`) and `bufferedEndPercent` (`0..100`), computed cleanly when `hasDuration && anchor.bufferHealth !== undefined`:
    - `bufferedStartMs = Math.max(0, positionMs - bufferHealth.bufferedBehindMs)`
    - `bufferedEndMs = Math.min(durationMs, positionMs + bufferHealth.bufferedAheadMs)`
  - Include `bufferedStartPercent` and `bufferedEndPercent` (rounded to `0.5%` steps to prevent needless re-renders!) in `sameProgressSnapshot`.
  - Render a single calm translucent range view (`testID="player-progress-buffered"`) inside `player-progress-rail` behind `player-progress-fill` (`left: bufferedStartPercent%`, `width: (bufferedEndPercent - bufferedStartPercent)%`, `backgroundColor: theme.colors.textMuted`, `opacity: 0.35`) adhering strictly to `docs/design/UI_UX_PHILOSOPHY.md`.
  - Also surface optional compact buffer depth (`Buf: +XXs / -YYs`) in `PlayerStatsHud` (`formatStatsHudLines`) when `bufferHealth` is present.

## 4. Android Media3 (`modules/engine-media3`)
- **`VodBufferPolicy.kt` (pure JVM Kotlin):** Mirrors `computeVodBufferBudget` (`VodBufferBudget`, `computeVodBufferBudget`, `nextThrottleBackoffLevel`, `hashCacheKeySha256`), preserving `LoadControlConfig.kt`'s `16 MiB` low-RAM ceiling and `>= 512 MiB` / `10%` free-disk rule.
- **`VodEphemeralCache.kt`:**
  - Creates a dedicated per-session directory under `context.cacheDir/vod-cache/s-<uuid>` when `budget.allowDiskCache` is true.
  - Wraps the single active gated upstream `DataSource.Factory` with Media3 `CacheDataSource.Factory` backed by `SimpleCache(sessionDir, LeastRecentlyUsedCacheEvictor(budget.maxDiskBytes), StandaloneDatabaseProvider(context))`, `CacheKeyFactory { spec -> hashCacheKeySha256(spec.uri.toString()) }` (NEVER raw URLs/tokens!), and `CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR`.
  - Never spawns any background prefetch thread or second upstream socket (`max_connections = 1`).
  - `releaseAndDelete()` closes `SimpleCache` safely off the main thread and deletes `sessionDir` recursively; `purgeOrphansOnStartup(cacheDir)` sweeps any crashed leftovers on startup.
- **`Media3Engine.kt` / `PlayerFactory.kt` / `EventReporter.kt`:**
  - Wire `VodEphemeralCache` strictly for `StreamKind.VOD`, clean up on `load()` / `stop()` / `recreate()` / `release()`, track `429`/`509` throttle backoff per session (reset on item change), and scale `DefaultLoadControl` back-buffer & forward targets via `VodBufferPolicy`.
  - Emit `bufferHealth: { bufferedAheadMs, bufferedBehindMs, diskCacheBytes?, throttled? }` on VOD `ClockAnchor` in `EventReporter.kt` (computing `bufferedAheadMs = max(0, player.bufferedPosition - player.currentPosition)` and `bufferedBehindMs` from back-buffer/cache window clamped to `currentPosition`).

## 5. Desktop `mpv` (`apps/desktop`)
- **`apps/desktop/src/shared/player-ipc.ts`:** Accept and validate optional `bufferPreset?: BufferPreset` on `LoadCommand` IPC messages (`isLoadCommand`), plus validate optional `bufferHealth` on `ClockAnchor` events.
- **`apps/desktop/src/main/player/mpv/vod-cache.ts`:**
  - Ephemeral sandbox-safe cache dir manager (`createVodCacheDir`, `cleanupVodCacheDir`, `purgeOrphanedVodCacheDirs` under `path.join(cacheRoot, 'elv-vod-cache')` where `cacheRoot` is `app.getPath('cache')` fallback `os.tmpdir()` — never hardcoded `/tmp`!).
  - Uses `@elv/playback` `computeVodBufferBudget` with `os.totalmem()` and `fs.statfsSync` free disk space + `429`/`509` throttle backoff state to compute VOD mpv per-file load options:
    - `cache-on-disk`: `'yes'` when `budget.allowDiskCache` else `'no'`
    - `demuxer-cache-dir`: ephemeral session dir when `budget.allowDiskCache`
    - `demuxer-max-bytes` & `demuxer-max-back-bytes` scaled to `budget.maxMemoryBytes` / `budget.maxDiskBytes`
    - `demuxer-readahead-secs` initialized to `Math.round(budget.forwardTargetMs / 1000)`
  - Live streams ALWAYS stay `cache-on-disk: 'no'` and keep live `demuxer-max-bytes` / `demuxer-max-back-bytes`.
  - Cleanly purges session dir on `stop`, next `load`, `dispose`, and sweeps orphans on desktop startup (`main.ts`).
- **`apps/desktop/src/main/player/mpv/derive.ts`:**
  - Populate `bufferHealth: { bufferedAheadMs, bufferedBehindMs }` on VOD `ClockAnchor` from `demuxer-cache-state` (`seekable-ranges` enclosing `timePos` or `cache-begin`/`cache-end`) and `demuxer-cache-duration`, ensuring `bufferedBehindMs` and `bufferedAheadMs` are non-negative finite milliseconds.

## 6. Apple `AetherEngine` (`modules/engine-aether`)
- **`modules/engine-aether/ios/Core/VodBufferPolicy.swift`:**
  - Pure Swift `AppleBufferPreset` (`auto`, `balanced`, `large`), `AppleVodBufferBudget`, `computeAppleVodBufferBudget(...)`, `AppleBufferHealth`, and `extractBufferHealth(fromLoadedRanges:currentTimeSeconds:)` (mirrors `@elv/playback` rules, RAM-tiered for `<= 2 GiB` / `<= 3 GiB` / `> 3 GiB` iOS & tvOS devices to prevent `jetsam` kills, `429`/`509` throttle backoff, strictly VOD-only).
- **`EngineTypes.swift`, `MediaPlan.swift`, `AetherLoadOptions.swift`, `ElvEngineAetherModule.swift`:**
  - Forward `bufferPreset` from JS -> `LoadRequest` -> `EngineLoadOptions` -> `AVPlayerItem.preferredForwardBufferDuration` (applied in `observeAVPlayerItem` for VOD only; `0` / default for live) while keeping `maxConcurrentSourceRequests = 1` and `urlCache = nil`.
- **`AetherBackend+Subscriptions.swift` & `EngineCore+Playback.swift`:**
  - Compute `bufferedAheadMs` and `bufferedBehindMs` from `AVPlayerItem.loadedTimeRanges` enclosing `currentTime` and include `bufferHealth` on emitted VOD `ClockAnchor` events (without dropping updates once `.playing`!).

## 7. Automated Proof Gate (`tools/src/gates/vod-cache-gate.ts`)
- Add a dedicated pure + simulator-backed VOD Rapid-Seek & Back-Buffer Proof Gate verifier (`tools/src/gates/vod-cache-gate.ts` + `tools/test/vod-cache-gate.test.ts`):
  - Evaluates rapid forward/backward seek traces + simulator HTTP request logs (`SimLogEntry[]`) + ephemeral cache audit snapshots:
    1. `overlapMs === 0` and `limitResponses === 0` (`max_connections = 1`).
    2. Backward seeks inside `bufferedBehindMs` incur `0` extra upstream HTTP requests (cache hit).
    3. Post-seek clock/audio/subtitle drift stays within tolerance (`<= 150 ms` A/V and subtitle drift, `decodedVideoFrames` continues advancing).
    4. Ephemeral cache snapshot contains zero raw URLs/tokens (SHA-256/opaque names only) and `0` leftover files after `stop()`/`dispose()`.
    5. `429`/`509` injection triggers throttle backoff cleanly without playback failure.
- Integrate with `tools/src/gates/index.ts` or exports so CI/tools cover it via `pnpm check`.

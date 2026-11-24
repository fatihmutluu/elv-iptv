# Wave F3 — Catch-Up, Live Time-Shift & Advanced EPG Design (`#220`, `#306`, `#27`, `#28`, `#30`, `#35`)

**Date:** 2026-11-24  
**Issues:** `#220` (Unified Catch-Up URL Resolver), `#306` (Xtream `get_simple_data_table` & `has_archive`), `#27` (Catch-Up Playback for Xtream & M3U), `#28` (Live Pause & Rewind / Bounded Time-Shift), `#30` (Multiple Guide Sources, Manual Channel Matching & Time Offsets), `#35` (Programme Reminders) — closes Epic `#344`.  
**Design Language:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — zero hardcoded hex colors in UI, zero React Native `<Modal>` on TV, 100% EN/TR Lingui parity, strict clean-room hygiene.

---

## 1. `#306` & `#220` — Xtream `simpleEpg` (`get_simple_data_table`) & Unified Catch-Up URL Resolver

### 1.1 `@elv/sources` (`xtream.ts`, `xtream-records.ts`, `xtream-types.ts`, `catchup-url.ts`)
- Add `simpleEpg(streamId: number, options?: XtreamCallOptions): Promise<Result<XtreamEpgEntry[]>>` to `XtreamClient` calling `&action=get_simple_data_table&stream_id=${streamId}` through the existing rate limiter, `429` cooldown, and mirror failover pipeline.
- Extend `XtreamEpgEntry` with optional `readonly hasArchive?: boolean` and `readonly nowPlaying?: boolean`, parsed in `toEpg()` via tolerant boolean coercion (`1`/`'1'`/`true` -> `true`, `0`/`'0'`/`false` -> `false`, omitted -> `undefined`).
- Add pure catch-up URL resolver `packages/sources/src/catchup-url.ts` supporting all 4 provider formats:
  - **Xtream (`xc`):** `{server}/timeshift/{username}/{password}/{durationMinutes}/{YYYY-MM-DD:HH-mm}/{streamId}.{ext}` formatting `YYYY-MM-DD:HH-mm` in the server's IANA timezone (`serverTimezone` via `Intl.DateTimeFormat`, falling back cleanly to UTC when absent/invalid).
  - **Stalker:** appends `?utc={startSec}&lutc={endSec}` (or `&utc=...` preserving existing query parameters).
  - **M3U `flussonic`:** rewrites `.m3u8` / `.ts` URLs to `{base}/archive-{utc}-{durationSec}.m3u8` / `{base}/timeshift_abs-{utc}.ts`.
  - **M3U `shift`:** appends `?utc={startSec}&lutc={endSec}` (or `&utc=...`).
  - **M3U `append` / `default`:** expands placeholders (`{utc}`, `{start}`, `{end}`, `{utcend}`, `{duration}`, `{offset}`, `${start}`, `${timestamp}`, `${duration}`, `${offset}`, `{Y}`, `{m}`, `{d}`, `{H}`, `{M}`, `{S}`, `{lutc}`) cleanly on `catchupSource` template (appended to stream URL for `append`, replacing base URL for `default`).
- Strict URL validation: rejects non-`http(s)` schemes, control chars, invalid timestamps (`stopMs <= startMs`), and expired windows (`stopMs < nowMs - catchupDays * DAY_MS`).

### 1.2 `@elv/data` Catch-Up Persistence & Play-Time Resolution
- Schema `MIGRATION_V16` (`schema-v16.ts`):
  - Adds `catchup_mode TEXT` and `catchup_source_template TEXT` to `live` and `live_next`.
  - Fixes M3U ingestion (`import-m3u.ts`, `m3u-headers.ts`, `writers-m3u.ts`, `content-hash.ts`, `catalog-commit.ts`) so `catchup` mode and templated `catchup-source` (tokenized via `st.book` so zero credentials/tokens ever enter SQLite!) are persisted cleanly, and `catchupDays` falls back `entry.catchup?.days ?? entry.timeshiftDays ?? entry.recordDays ?? null`.
  - Persists `serverTimezone` in `SourceSettings` during `importXtream` so play-time catch-up URL formatting needs zero extra `account()` round-trip.
- Exposes `catchupDays?: number | null` on `ItemRow` (`queries-shared.ts`).
- Adds `resolveCatchupStream(itemKey: string, programme: { startMs: number; stopMs: number; hasArchive?: boolean }, opts?: ParentalQueryOptions): Promise<Result<StreamRequest>>` and `fetchChannelArchiveEpg?(itemKey: string, opts?: ParentalQueryOptions): Promise<Result<ProgrammeRow[]>>` (wrapping Xtream `simpleEpg` when available) to `CatalogService` & `write-coalescer.ts` (enforcing parental controls `#31` before resolving!).

---

## 2. `#27` — Catch-Up Playback UI (EPG & Player)
- Past EPG slots (`programme.stop <= nowMs` within `channel.catchupDays`) display a subtle catch-up availability badge in `EpgChannelRow` / `EpgGridView`.
- Selecting a past programme opens `EpgProgrammeDetailModal` with a primary **"Watch catch-up"** CTA (when within window and `hasArchive !== false`), alongside "Watch live" and "Close". Past programmes outside the retention window or with `hasArchive === false` display a clear localized unavailable note.
- Catch-up plays via `PlayableEntry` carrying optional `catchup: { startMs: number; stopMs: number; liveChannelKey: string; liveChannelTitle: string; programmeTitle: string }`:
  - Uses VOD scrub controls (`-10s/+10s`, seek bar, pause, playback speed) while skipping VOD `watch_progress` writes so ephemeral catch-up never pollutes Movies/Series Continue Watching.
  - Displays a sleek **"Back to live"** pill CTA in `PlayerScreen` that cleanly tears down the catch-up stream (`ConnectionGate` / `max_connections = 1` safe) and tunes `liveChannelKey`.

---

## 3. `#28` — Pause & Rewind Live TV (Bounded Time-Shift)

### 3.1 `@elv/playback` Contract (`engine.ts`, `service.ts`, `service-events.ts`, `native-bridge.ts`)
- Extend `ClockAnchor` with optional `readonly liveSeekableStartMs?: number` and `readonly timeShiftSupported?: boolean` (alongside existing `liveEdgeMs?: number`).
- In `resolveSeekTarget` & `PlaybackService.performSeek`: when `kind === 'live'` and `liveSeekableStartMs !== undefined && liveEdgeMs !== undefined && liveEdgeMs > liveSeekableStartMs`, clamp seek targets strictly within `[liveSeekableStartMs, liveEdgeMs]` and allow seeking!
- Extend `PlaybackService.jumpToLiveEdge()` to seek directly to `liveEdgeMs` whenever live time-shift is active (behind live edge by > 2s), not only when `isLiveTs === true`.

### 3.2 Engine Implementations
- **Desktop `libmpv` (`apps/desktop/src/main/player/`):**
  - Enable bounded back-buffer on live streams (`demuxer-max-back-bytes: 128MiB` in memory, zero persistent disk sprawl, cleanly cleared on `loadfile`/`stop`).
  - Extract both `cache-begin` (`liveSeekableStartMs`) and `cache-end` (`liveEdgeMs`) from `demuxer-cache-state` (`derive.ts`), setting `timeShiftSupported: true` when seekable span >= 2,000 ms and exposing `liveSeek: true` in `DESKTOP_CAPABILITIES`.
- **Android `Media3` (`modules/engine-media3/android/`):**
  - Keep `DefaultLoadControl` RAM cap strictly at `16 MiB` on low-RAM devices (`< 1.5 GiB` / `isLowRamDevice`).
  - Emit `liveSeekableStartMs` and `liveEdgeMs` from `Timeline.Window` / `player.currentLiveOffset` whenever `current.isCurrentMediaItemSeekable` (HLS sliding window) OR backed by bounded disk time-shift ring buffer (`TimeShiftRingBuffer.kt` for raw MPEG-TS live streams, strictly bounded in `cacheDir/timeshift/` — 64 MiB on low-RAM, 256 MiB otherwise, cleaned synchronously on close/zap/dispose so zero orphan files or sockets survive).
- **Apple `AetherEngine` (`modules/engine-aether/ios/`):**
  - Lift `!engine.isLive` guard in `AetherBackend.seek` / `EngineMainDriver` when live seekable window is present (`liveSeekableStartMs < liveEdgeMs`).
  - Read `AVPlayerItem.seekableTimeRanges` (when available for live HLS streams) to populate `liveSeekableStartMs`, `liveEdgeMs`, and `timeShiftSupported`; gracefully report `timeShiftSupported: false` on forward-only raw TS streams so UI never offers broken seek controls.

### 3.3 Player UI
- When playing live TV with `timeShiftSupported === true` (or paused behind live edge): show subtle time-shift scrubber + behind-live offset indicator (`-02:14`) + `-10s/+10s` seek support + **"Jump to live"** pill CTA in Cinema Quietude v2 style.

---

## 4. `#30` — Multiple Guide Sources, Manual Channel Matching & Time Offsets

### 4.1 Schema `MIGRATION_V16` (`schema-v16.ts`)
- `guide_sources (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, url_template TEXT NOT NULL, epg_shift_ms INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, last_sync_at INTEGER, http_cache_json TEXT)` + `idx_guide_sources_source (source_id, priority)`.
  - URLs/tokens are tokenized into `SecretStore` (`urlvars` via `{{g:<guideId>}}`) so raw guide URLs/credentials NEVER enter SQLite!
- `channel_guide_overrides (source_id TEXT NOT NULL, channel_key TEXT NOT NULL, guide_source_id TEXT, guide_id TEXT, epg_shift_ms INTEGER NOT NULL DEFAULT 0, is_manual INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_id, channel_key)) WITHOUT ROWID`.
- Priority-ordered multi-guide ingestion in `import-guide.ts` & `guide-commit.ts`:
  - Runs configured `guide_sources` in ascending `priority` order (falling back to existing `SourceSettings.guideUrl` / Xtream XMLTV when no extra guides exist).
  - Tier-0 manual overrides (`channel_guide_overrides` where `is_manual = 1`) ALWAYS win and are NEVER deleted on playlist or guide refresh.
  - Higher-priority guides claim unmatched channels first; lower-priority guides fill remaining unmatched channels cleanly.
  - `guide-queries.ts` combines `channel_guide_overrides.epg_shift_ms` + `guide_sources.epg_shift_ms` + `live.epg_shift_ms` + `SourceSettings.epgShiftMs`.
- New `CatalogService` methods (also bridged in `write-coalescer.ts`, `lazy-catalog.ts`, `profile-scoped-catalog.ts`, and Desktop IPC):
  - `listGuideSources?(sourceId: string): Promise<GuideSourceRecord[]>`
  - `addGuideSource?(input: AddGuideSourceInput): Promise<Result<GuideSourceRecord>>`
  - `updateGuideSource?(id: string, patch: UpdateGuideSourcePatch): Promise<Result<GuideSourceRecord>>`
  - `removeGuideSource?(id: string): Promise<Result<void>>`
  - `reorderGuideSources?(sourceId: string, orderedIds: readonly string[]): Promise<Result<void>>`
  - `listGuideChannels?(sourceId: string, query?: string, limit?: number): Promise<GuideChannelOption[]>`
  - `listChannelGuideOverrides?(sourceId: string): Promise<ChannelGuideOverrideRecord[]>`
  - `setChannelGuideOverride?(input: SetChannelGuideOverrideInput): Promise<Result<ChannelGuideOverrideRecord>>`
  - `clearChannelGuideOverride?(sourceId: string, channelKey: string): Promise<Result<void>>`
- UI inside **Settings -> Sources** (`GuideManagementOverlay.tsx`): add/remove/reorder multiple XMLTV URLs per source, per-guide offset (`-12h .. +12h`), and searchable Manual Channel Mapper (All / Unmatched filter, pick `guide_id` + per-channel EPG offset).

---

## 5. `#35` — Programme Reminders

### 5.1 Schema `MIGRATION_V16` & Repository (`reminders-repo.ts`)
- `programme_reminders (profile_id TEXT NOT NULL DEFAULT 'default', source_id TEXT NOT NULL, channel_key TEXT NOT NULL, channel_name TEXT NOT NULL, programme_title TEXT NOT NULL, programme_start INTEGER NOT NULL, programme_stop INTEGER NOT NULL, lead_time_ms INTEGER NOT NULL DEFAULT 300000, fired INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, channel_key, programme_start)) WITHOUT ROWID`
  - Indexes: `idx_programme_reminders_due (profile_id, fired, programme_start)`, `idx_programme_reminders_source (source_id)`.
- Registered in `EXPECTED_TABLE_COLUMNS`, `TABLES_BY_SOURCE` (`finishDeletingSource`), `deleteProfile` cascade, and `catalog-commit.ts` legacy key migration.
- `reconcileRemindersAfterGuideImport` automatically reconciles slight start-time shifts (`<= 30 min`) when XMLTV updates a scheduled programme's start timestamp.
- New `CatalogService` methods: `listReminders`, `upsertReminder`, `removeReminder`, `markReminderFired`, `pruneExpiredReminders`.

### 5.2 Scheduler & Cinema Quietude v2 UI
- `EpgProgrammeDetailModal.tsx`: adds **"Remind me"** / **"Cancel reminder"** toggle for upcoming programmes (`programme.start > nowMs`).
- `EpgChannelRow.tsx`: displays a subtle reminder bell indicator on scheduled future programme cells.
- `useProgrammeReminders` hook in `AppShell` (`app-shell-reminders.ts`): schedules a single timer for the next due reminder (`programmeStart - leadTimeMs`), re-syncs on foreground/profile/guide changes, respects parental controls (`#31` — never shows or fires reminders for restricted programmes while locked!), marks fired once shown, and renders a sleek non-intrusive Cinema Quietude banner (`ReminderToastBanner.tsx`) with **"Tune now"** (routed cleanly through `connectionGuard` / `playbackGuard` so `max_connections = 1` is never violated!) and **"Dismiss"** — NEVER auto-stealing active playback!
- Optional lightweight `ReminderHostPort` (`packages/features/src/ports/reminder-host.ts`) so Desktop can surface an OS notification when the window is unfocused without adding heavy native dependencies.

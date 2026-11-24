# Wave F0A — EPG Proof Gate, XMLTV Hardening & Apple Detached Surface Design (`#6`, `#25`, `#268`, `#117`)

- **Date:** 2026-11-24
- **Issues:** `#6`, `#25`, `#268`, `#117`
- **Epic closed upon merge:** `#334` (XMLTV EPG Ingestion, Matching & 1000-Channel Grid; leaves 0 `priority:critical` issues in repo)
- **Design philosophy:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — O(1) virtualized windowing, zero hardcoded hex, zero RN `<Modal>` on TV, 100% EN/TR Lingui parity, `<= 16 ms` JS frames & `< 100 ms` key-to-highlight budgets.

## 1. `#268` — XMLTV Catch-Up Retention Guard & `<desc>` Leading Episode Fallback
- **Leading `<desc>` fallback (`packages/sources/src/xmltv-meta.ts`):**
  - When `<episode-num>` is absent, `extractDescEpisodeNum(desc)` extracts leading episode patterns anchored at the start of trimmed `<desc>`:
    1. `S01E01` (`S\d{1,3}E\d{1,4}\b`) — normalized to uppercase `S<N>E<M>` (preserving zero-padding).
    2. `Season <N> Episode <M>` (`Season\s+(\d{1,3})\s*[,:-]?\s*Episode\s+(\d{1,4})\b`) — normalized to `S<NN>E<MM>`.
    3. `<S>x<EE>` (`(\d{1,3})x(\d{2,4})\b`, strictly requiring **2+ episode digits** so `1x1` or `2x4` aspect ratios never false-match) — normalized to `S<NN>E<MM>`.
  - Never overwrites a valid `<episode-num>`.
- **Bad early timestamp catch-up retention guard (`packages/sources/src/xmltv.ts`, `packages/data/src/import-guide.ts`, `packages/data/src/guide-commit.ts`):**
  - Add a sanity epoch floor (`MIN_VALID_XMLTV_EPOCH_MS = Date.UTC(1990, 0, 1)`) and per-source catch-up retention window (`maxCatchupDays` queried from `live.catchup_days` for that source, clamped `[0, 30]`).
  - `retentionFloorMs = now - Math.max(window.daysBack, maxCatchupDays) * DAY_MS`.
  - Any `<programme>` with `start < MIN_VALID_XMLTV_EPOCH_MS` or `stop <= retentionFloorMs` is rejected/ignored with a `programme-bad-time` warning so a single corrupt early timestamp (e.g. `19700101`) can NEVER skew retention cutoffs or wipe retained catch-up programmes.
  - During `guide-commit.ts` refresh, valid previously stored past catch-up programmes (`stop > retentionFloorMs && start < freshEarliestValidStart`, where `freshEarliestValidStart` only considers valid timestamps `>= retentionFloorMs`) are preserved cleanly into `programmes_next` before the atomic swap, so a partial or future-only XMLTV refresh never wipes retained catch-up history.
- **SQLite index (`packages/data/src/schema.ts`, `packages/data/src/migrations.ts` `MIGRATION_V13`):**
  - Add `CREATE INDEX IF NOT EXISTS idx_programmes_source_stop ON programmes (source_id, stop);` for fast expired-programme pruning and catch-up retention queries.

## 2. `#6` & `#25` — EPG Grid Ergonomics & Real Proof Gates (`android-tv` + `tvos`)
- **Row density presets (`EpgRowDensity = 'compact' | 'comfortable' | 'cinematic'`, default `'comfortable'`):**
  - Stored in `@elv/domain` (`epgRowDensity`) with validator, default `'comfortable'`, EN/TR i18n keys (`settings.epgRowDensity`, `settings.epgRowDensityCompact`, `settings.epgRowDensityComfortable`, `settings.epgRowDensityCinematic`, `epg.noInfoGap`), settings toggle in `LiveTvSettingsPanel.tsx`, threaded through `AppShell` -> `LiveScreen` -> `EpgGridView` (`compact: 52/48`, `comfortable: 68/60`, `cinematic: 84/74` scaled by `safeFontScale`).
- **Auto-scroll & focus currently playing channel on EPG open:**
  - `EpgGridView` accepts `activeChannelKey?: string | null` (passed from `LiveScreen`). On initial open (when loaded channels contain `activeChannelKey`), `useEpgTimeCursor` initializes `focusedRow` to that channel's index and scrolls the virtualized list smoothly to keep it visible.
- **Synthesized focusable `>= 5 min` (`300_000 ms`) "No info" gap cells (`packages/features/src/live/live-model.ts`, `EpgChannelRow.tsx`):**
  - `layoutEpgSlots` synthesizes focusable gap slots (`isGap: true`, `title: ''` rendered with `epg.noInfoGap` / `epg.noGuideData`) for any uncovered span `>= 300_000 ms` before, between, or after programmes within `[windowStartMs, windowEndMs]` (and for rows with 0 programmes), guaranteeing D-pad UP/DOWN/LEFT/RIGHT never skips or traps focus.
- **Hold-Left sidebar ergonomics & smooth focus styling:**
  - `useEpgTimeCursor` handles `long` `'left'` to jump cleanly to the category sidebar (alongside left-edge escape), and memoizes `EpgChannelRow` to avoid unnecessary row re-renders on cursor movement.
- **Proof gates (`apps/tv-mobile/src/gate/`, `tools/src/gates/`):**
  - `apps/tv-mobile/src/gate/epg/EpgGateScreen.tsx` (`elviptv://gate/epg`): mounts real `EpgGridView` backed by an O(1)-windowed synthetic `1,000` channels × `7` days EPG dataset, runs scripted D-pad navigation (vertical rows, overlap jumps, gap cells, horizontal time pan, fast hold repeats), asserts focus continuity, `< 100 ms` remote-key-to-highlight, and `<= 16 ms` JS frame budget, and emits `ELV_GATE {"gate":"epg",...}`.
  - `tools/src/gates/epg-gate.ts` (`pnpm gate epg --target android-tv|tvos`): runs `elviptv://gate/epg` on Android TV (`adb` + `dumpsys gfxinfo`) and tvOS (`simctl.ts`), enforcing `spec §6.2` dropped-frame and `< 100 ms` budgets.
  - Extend `apps/tv-mobile/src/gate/import/run-import.ts` (`guide=1` parameter) and `tools/src/gates/import-gate.ts` (`--guide`, `--target android-tv|tvos`): benchmarks streaming XMLTV import of `5,000` channels × `7` days from `pnpm sim` into SQLite under `< 60 s` within memory budget.

## 3. `#117` — Apple iOS/tvOS Non-Terminal Detached Player Surface
- **`modules/engine-aether/ios/Core/EngineCore.swift`:**
  - Add `allowDetachedSurface: Bool` (default `false`) and `isSurfaceDetached: Bool` state.
  - When `surfaceChanged(available: false, isBackground: ...)` fires while `isBackground == true || allowDetachedSurface == true`, transition cleanly to detached mode: clear subtitles, release screen-on, emit `.surface(attempt: token, change: .destroyed)` WITHOUT incrementing `serial`, stopping media, or emitting fatal `"surface-lost"`.
  - When `surfaceChanged(available: true)` reattaches while `active && played && !userPaused && !stalled && !externalPlaybackActive`, restore `setScreenOn(true)` and emit `.surface(attempt: token, change: .created)`.
  - Preserve fatal `"surface-lost"` when `!isBackground && !allowDetachedSurface`.
- **`modules/engine-aether/ios/Engine/AetherSurfaceView.swift`:**
  - Treat `didMoveToWindow()` with `window == nil && UIApplication.shared.applicationState != .active` as `isBackground = true` so UIKit window teardown racing ahead of `didEnterBackgroundNotification` never causes spurious `surface-lost`.
- **`modules/engine-aether/ios/Engine/AetherBackend.swift` & `AetherBackend+Subscriptions.swift` & `EngineMainDriver.swift` & `EngineObject.swift` & `ElvEngineAetherModule.swift` & `src/index.ts`:**
  - Add `clearPlayerItemObservers()` ensuring every `AVPlayerItem` KVO/Combine observer (`itemProgressCancellable`, `avPlayerItemBufferCancellables`) is torn down immediately before item replacement, stop, rebuild, or dispose, and verify async `loadTask` / `mediaInfoTask` generation fencing cancels superseded resolutions cleanly.
  - Expose `setAllowDetachedSurface(_ enabled: Bool)` (automatically enabled when `backgroundAudioEnabled == true` OR explicitly via `setAetherDetachedSurfaceAllowed(engine, enabled)` for PiP `#34`).
  - Add comprehensive Swift 6 tests in `EngineCoreLifecycleTests.swift` and TS tests in `modules/engine-aether/src/index.test.ts`.

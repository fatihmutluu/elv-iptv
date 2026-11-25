# Wave F7B Design Spec — External Display, Multi-Program MPEG-TS, External Player, Crash Telemetry, LGPL Windows mpv CI & Hermes TV XMLTV Import Perf (`#258`, `#304`, `#406`, `#226`, `#94`, `#478`)

**Date:** 2026-11-25  
**Scope:** Closes `#258`, `#304`, `#406`, `#226`, `#94`, `#478`.

## 1. Architecture & Layer Placement

All changes follow the Foundation Spec §5.2 dependency boundaries and the Cinema Quietude v2 UI/UX philosophy (`docs/design/UI_UX_PHILOSOPHY.md`):

- **`@elv/domain` (`packages/domain`):**
  - `redact.ts`: Extend `redactText` to also scrub OS local home-directory usernames (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, `/data/user/<id>`) so diagnostic crash reports and stack traces never leak user identifiers.
  - `crash-report.ts` (`#226`): Pure `RingLogBuffer` (`maxLines = 250`, redacts on push and again on snapshot) and `buildCrashReportMarkdown(input)` producing double-redacted Markdown diagnostics gated strictly by explicit opt-in (`includeLogs` defaults to `false`).
  - `preferences-wave-f7b.ts` (`#226`, `#406`): Preferences `crashReportsOptIn` (`false`), `crashReportsIncludeLogs` (`false`), `externalPlayerMode` (`'off' | 'ask' | 'always'`, default `'off'`), and `externalPlayerApp` (`'chooser' | 'vlc' | 'mpv' | 'mx' | 'infuse' | 'outplayer'`, default `'chooser'`).

- **`@elv/playback` (`packages/playback`):**
  - `engine.ts`, `types.ts`, `native-bridge.ts`, `programs.ts` (`#304`): Add `ProgramInfo` (`id`, `label`, `serviceName?`, `programNumber?`), optional `programId` on `TrackInfo` and `LoadOptions`, optional `programs` and `selectedProgramId` on `MediaTracks`, optional `programSelection` on `EngineCapabilities`, and optional `selectProgram(attempt, id)` on `PlayerEngine` / `PlaybackService`. Preserve `programs` and `selectedProgramId` in `normalizeTracksEvent`, and expose pure `filterTracksByProgram(tracks)` to scope audio/subtitle/video tracks to the active service when multiple programs exist.

- **`@elv/xmltv-native` (`modules/xmltv-native`) + `@elv/data` (`packages/data`) (`#478`):**
  - `@elv/data`: Add optional `nativeGuideStager?: NativeGuideStager` port to `ImportDeps` (keeping `@elv/data` 100% pure TypeScript). When present on mobile/TV devices for HTTP(S) XMLTV feeds, `importGuide` stages programmes off the JS thread via `nativeGuideStager` (honoring retries, HTTP 304 conditional cache, abort cancellation, and redacted error codes) while preserving the JS `scanXmltv` path on Desktop/Node/tests and chunking `finalizeChannels`, channel-mapping writes, and `POPULATE_PROGRAMMES_FTS` in `guide-commit.ts` with `scheduler.yieldNow()` so JS stalls stay `<= 100 ms`.
  - `@elv/xmltv-native`: Self-contained Expo native module (Android Kotlin + Apple iOS/tvOS Swift, zero third-party pods/Maven deps) that streams HTTP(S) responses (with transparent gzip detection and conditional ETag/Last-Modified), parses XMLTV bytes on a native background thread (matching `@elv/sources` `<channel>` / `<programme>` / timezone / entity / genre / flags / `foldText` / overlap-clamping semantics), and writes directly into `programmes_next` in WAL-compatible SQLite (`INSERT OR REPLACE`) in 2,500-row batches so the Hermes JS thread allocates zero programme objects and completes 5,000 ch × 7d in `< 60 s` with `guideMaxStallMs <= 100 ms`.

- **`@elv/engine-aether` (`modules/engine-aether`) (`#258`, `#304`):**
  - `Core/ExternalDisplayPolicy.swift`: Pure Swift state machine modeling inline vs external `UIWindowScene` routing (`surfaceAvailable` remains `true` across reparenting so `EngineCore` never emits `surface-lost`, PiP pauses while external scene is active, disconnect restores inline playback seamlessly).
  - `Engine/AetherExternalDisplayManager.swift` + `Engine/AetherExternalSceneDelegate.swift` (`#if os(iOS)`): Dedicated non-interactive `UIWindowScene` host (`UIWindowSceneSessionRoleExternalDisplayNonInteractive`) + primary-scene bridge (`AetherPrimaryWindowSceneDelegate`) preserving Expo `AppDelegate` root window and deep links (`elviptv://`). Wired via `!tv` Expo config plugin `apps/tv-mobile/config/with-ios-external-display.ts`.

- **`@elv/engine-media3` (`modules/engine-media3`) (`#304`, `#406`):**
  - `TrackInspection.kt` + `Media3Engine.kt` (`#304`): Detect multi-program MPEG-TS service grouping from `Format.id` / track groups and support `selectProgram(programId)` by scoping track selection to the selected service.
  - `ExternalPlayerLauncher.kt` + `ElvEngineMedia3Module.kt` (`#406`): `launchExternalPlayer` via `Intent.ACTION_VIEW` + `OnActivityResult` (dedicated request code) passing safe `title` / `position` / `return_result` extras without ever logging stream URLs/headers, and returning clamped `{ positionMs, durationMs, completed }` for watch-progress persistence.

- **Desktop Electron + `mpv` (`apps/desktop`, `tools/mpv-runtime`, `tools/src/mpv`, `.github/workflows/mpv-runtime.yml`) (`#304`, `#226`, `#94`):**
  - `#304`: Observe mpv `program` property and `track-list` `program-id` entries, add `program` to `--reset-on-next-file`, and route `selectProgram` cleanly across `player-ipc-wave-f7b.ts`, `ipc-commands.ts`, `engine.ts`, and `desktop-engine.ts`.
  - `#226`: Expose redacted `readLogTail(maxLines <= 250)` and `exportCrashReport(markdown)` over the Desktop preload bridge.
  - `#94`: Add `tools/mpv-runtime/build-windows.sh` (MSYS2 `mingw64`, baseline `-march=x86-64 -mtune=generic`, FFmpeg `--enable-shared --disable-static --disable-gpl --disable-nonfree --enable-d3d11va --enable-dxva2 --enable-schannel`, mpv `-Dgpl=false -Dlibmpv=true -Dlua=luajit -Dd3d11=enabled`, transitive DLL bundler with zero symlinks, `include/mpv/*.h`, full `licenses/`, and `RUNTIME-BUILDINFO.json`), add the `win32-x64` job to `.github/workflows/mpv-runtime.yml`, preserve `RUNTIME-BUILDINFO.json` in `tools/src/mpv/fetch.ts`, and surface all bundled LGPL Windows libraries in `ThirdPartyNotices`.

- **UI & i18n (`@elv/i18n`, `@elv/features`, `apps/tv-mobile`, `apps/desktop/renderer`) (`#258`, `#304`, `#406`, `#226`):**
  - `@elv/i18n`: Full EN/TR parity in `en-wave-f7b.ts` / `tr-wave-f7b.ts` + `.po` catalogs.
  - `TrackPickerModal.tsx` + `track-picker-nav.ts` (`#304`): Conditional Program/Service column strictly when `(tracks.programs?.length ?? 0) > 1`, with D-pad navigation and safe cursor clamping.
  - `PlayerScreenStage.tsx` + `usePlayerSession.ts` (`#258`): Cinema Quietude "Playing on External Display" stage card on iOS/iPadOS keeping handheld OSD/controls active.
  - `AppShell.tsx` + `PlaybackSettingsPanel.tsx` (`#406`): Opt-in External Player Mode (`Off` / `Ask` / `Always`) & Preferred App on mobile; guarantees internal preview/player teardown and `ConnectionGuard` clearance before handoff, and saves valid returned watch progress.
  - `CrashRecoveryBoundary.tsx` + `CrashReportPreviewModal.tsx` + Settings Diagnostics section (`#226`): Opt-in redacted Markdown diagnostic preview/copy/export (no RN `<Modal>` on TV; D-pad navigable).

## 2. Verification Plan
- Strict TDD (`RED -> GREEN -> REFACTOR`) across all modified packages (`>= 90%` line coverage on pure packages).
- Full `pnpm check` (`11 passed, 0 failed`), Android Gradle unit tests (`:elv-engine-media3:testDebugUnitTest`, `:elv-xmltv-native:testDebugUnitTest`), Apple Swift tests on `elv-mac`, live Hermes TV XMLTV import gate runs (`android-tv` `elv_tv` + `tvos` on `elv-mac` proving `< 60 s` and `guideMaxStallMs <= 100 ms`), and independent whole-branch `Neon High` review (`VERDICT: PASS`).

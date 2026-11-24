# Wave F4 — Subtitles Suite Design (`#285`, `#308`, `#32`, `#402`, `#223`)

**Date:** 2026-11-24  
**Issues:** `#285` (Tolerant SRT/VTT/ASS/TTML parser + Apple RTL/bidi isolation), `#308` (External subtitle `DataSource` header/credential isolation), `#32` (External subtitle files & live subtitle styling), `#402` (Simultaneous dual subtitles across all engines & OSD), `#223` (Android Media3 native ASS/SSA OpenGL subtitle overlay via MIT/LGPL-verified `libass`).  
**Design Language:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — zero hardcoded hex colors in UI, zero React Native `<Modal>` on TV, 100% EN/TR Lingui parity, strict clean-room & LGPL dynamic-linking hygiene.

---

## 1. `#285` — Tolerant SRT/VTT/ASS/TTML Parser & Apple RTL/Bidi Isolation

### 1.1 `@elv/sources` Pure Subtitle Parser (`packages/sources/src/subtitles.ts`)
- Types: `SubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ttml'`, `ParsedSubtitleCue { startMs, endMs, text, isRtl }`, `ParsedSubtitleTrack { format, cues, warnings }`.
- `detectSubtitleFormat(content, hint?)`: inspects BOM/headers (`WEBVTT`, `[Script Info]`/`Dialogue:`, `<tt`, or SRT timecode lines) and optional file extension / MIME hint.
- `parseSubtitles(content, opts?)`:
  - Strips UTF-8/16 BOM, normalizes `\r\n`/`\r`, caps input length cleanly (`maxBytes`, default `4 MiB`).
  - **SRT / WebVTT:** timecode-line-anchored scanner (`HH:MM:SS,mmm --> HH:MM:SS,mmm` tolerating missing hours, `.` or `,` or `:` ms separators, 1–3 digit ms, `->`/`—>` arrow typos, missing cue indices, extra blank lines, WebVTT `NOTE`/`STYLE`/`REGION` blocks, and cue settings after end timestamp). Discards/clamps negative durations without dropping subsequent cues; single-pass HTML/VTT/ASS tag stripping + HTML entity decoding.
  - **ASS / SSA:** parses `[Events]` `Format:` field order dynamically, extracts `Start`, `End`, `Text`, converts `\N`/`\n` to newline and `\h` to space, strips `{...}` override tags and vector drawing blocks (`{\p1}...{\p0}`).
  - **TTML:** extracts `<p begin="..." end="...">` (supporting clock `HH:MM:SS.mmm`, `HH:MM:SS:ff`, and offset units `s`/`ms`/`m`/`h`), preserves `<br/>` line breaks, decodes XML entities.
  - Optional SDH filtering hook and deterministic sort by `(startMs, endMs)` + overlapping cue helper `findActiveCues(cues, positionMs)`.
  - Bidi utilities: `containsRtlText(text)` (Arabic, Hebrew, Syriac, Thaana, N'Ko, presentation forms) and `isolateBidiLines(text)` wrapping RTL lines with Unicode First-Strong/Right-to-Left isolates (`\u2067...\u2069`).

### 1.2 Apple `AetherEngine` RTL/Bidi Isolation (`modules/engine-aether/ios/`)
- Pure Swift 6 `Core/SubtitleBidi.swift` (`containsStrongRtl`, `isolateBidiLines`, `writingDirection`, `mergeOverlappingLines`) with comprehensive unit tests in `CoreTests/SubtitleBidiTests.swift`.
- `Engine/SubtitlePresentation.swift` & `Engine/AetherSubtitleOverlayView.swift`: wraps RTL lines in `\u{2067}...\u{2069}` and sets `paragraph.baseWritingDirection = .rightToLeft` for RTL lines so trailing punctuation renders on the visually correct side in mixed RTL+LTR cues, while deduplicating/merging overlapping cues cleanly.

---

## 2. `#308` — Isolated External Subtitle Transport (Zero Stream Credential Leakage)

### 2.1 `@elv/playback` Contract (`packages/playback/src/engine.ts`, `types.ts`, `service.ts`)
- Add `ExternalSubtitleTrack { id, uri, label?, language?, mimeType?, headers? }` and `SubtitleStyleConfig` import from `@elv/domain`.
- Extend `LoadOptions` with `externalSubtitles?: readonly ExternalSubtitleTrack[]`, `secondarySubtitleTrackId?: string | null`, and `subtitleStyle?: SubtitleStyleConfig`.
- Extend `EngineCapabilities` with `externalSubtitles?: boolean`, `subtitleStyling?: boolean`, `dualSubtitles?: boolean`.
- Extend `PlayerEngine` & `PlaybackService` with `addExternalSubtitle?(attempt, track)` and `setSubtitleStyle?(style)`.

### 2.2 Per-Engine Isolation Invariant
- **Android Media3 (`StreamHttp.kt`, `MediaSources.kt`, `Media3Engine.kt`):**
  - Dedicated `StreamHttp.subtitleDataSourceFactory(subtitleHeaders, allowLegacyTls)` completely separate from the primary stream `DataSource.Factory` (zero stream `Authorization`, `Cookie`, `User-Agent`, `Referer`, or custom headers inherited; strips sensitive per-subtitle headers on cross-origin redirects; allows only `http://`, `https://`, `file://`, `content://`).
  - Verified with an HTTP mock-server test asserting primary stream `Authorization`/`Cookie` never appear on subtitle requests.
- **Apple `AetherEngine` (`StreamHttp.swift`, `AetherBackend+ExternalSubtitles.swift`):**
  - Dedicated ephemeral `URLSession` (`httpShouldSetCookies = false`, `httpCookieStorage = nil`, `httpAdditionalHeaders = nil`) with cross-origin redirect header stripping for external HTTP(S) subtitle fetches (bounded `<= 4 MiB`), plus safe local `file://` reads, parsed via pure Swift tolerant SRT/VTT/ASS parser (`ExternalSubtitleParser.swift`) and rendered through `AetherSubtitleOverlayView`.
- **Desktop `libmpv` (`apps/desktop/src/main/player/subtitle-fetch.ts`, `engine.ts`):**
  - External HTTP(S) subtitles are NEVER fetched through `mpv`'s stream `--http-header-fields`. Electron main fetches via an isolated credential-free HTTP client (zero stream headers/cookies, `<= 4 MiB` cap, cross-origin redirect auth strip), writes to a per-session temp directory (`os.tmpdir()/elv-subs-<session>/`), passes the local temp path to `mpv` `sub-add`, and deletes all temp files synchronously on `stop()` / `load()` / `release()`. Local files are validated for extension & regular-file existence before `sub-add`.

---

## 3. `#32` — External Subtitle Files & Live Subtitle Styling

### 3.1 `@elv/domain` Preferences (`preferences-validators.ts`, `preferences.ts`)
- Add `SubtitleStyleConfig`:
  - `fontSize`: `'small' | 'medium' | 'large' | 'extraLarge'` (default `'medium'`)
  - `textColor`: `'white' | 'yellow' | 'cyan' | 'green'` (default `'white'`)
  - `backgroundColor`: `'none' | 'translucent' | 'opaque'` (default `'translucent'`)
  - `edgeStyle`: `'none' | 'outline' | 'dropShadow'` (default `'outline'`)
  - `verticalPosition`: `'bottom' | 'raised' | 'top'` (default `'bottom'`)
- Persist `subtitleStyle: SubtitleStyleConfig` on `PreferencesSnapshot` with strict validation and fallback defaults, staying well within `MAX_PREFERENCES_BYTES` (4096 bytes).

### 3.2 Live Cross-Engine Styling (Zero Restart)
- **Android Media3 (`SubtitleStyleMapper.kt`, `Media3SurfaceView.kt`):** maps `SubtitleStyleConfig` to `CaptionStyleCompat` (`foregroundColor`, `backgroundColor`, `edgeType`, `edgeColor`, `typeface`), fixed `sp`/`dp` text size (`setFixedTextSize`), and `setBottomPaddingFraction` combined with OSD `subtitleBottomInsetPx`.
- **Apple `AetherEngine` (`CaptionAppearanceStyle.swift`, `AetherSubtitleOverlayView.swift`):** layers user `SubtitleStyleConfig` overrides over `MACaptionAppearance` (`foreground`, `background`, stroke/shadow edge attributes, font scale, vertical placement) live without restarting playback.
- **Desktop `libmpv` (`subtitle-style.ts`, `engine.ts`, `ipc.ts`, `desktop-engine.ts`):** maps `SubtitleStyleConfig` to `sub-scale`, `sub-color`, `sub-back-color`, `sub-border-size`, `sub-shadow-offset`, `sub-pos`, updated live via `set_property` and included in `loadfile` options.

### 3.3 UI Controls (`packages/features` + `apps/desktop`)
- Add optional `pickSubtitleFile?(): Promise<ExternalSubtitleTrack | null>` on `VideoHost` (Desktop: sandbox-safe Electron `dialog.showOpenDialog` IPC filtered to `.srt`/`.vtt`/`.ass`/`.ssa`/`.ttml`; TV/Mobile: in-tree external subtitle URL input overlay using `TvTextInput` + `TextEntryBoundary`).
- Expose **"Load external subtitle"** and **"Subtitle appearance"** (Size, Color, Background, Edge, Position) inside `PlayerSettingsSheet` / `TrackPickerModal` (Cinema Quietude v2, zero hex colors, zero `<Modal>`, 100% TV D-pad navigable, EN/TR Lingui parity).

---

## 4. `#402` — Simultaneous Dual Subtitles Across Engines & OSD
- **`@elv/playback`:**
  - `PlaybackService.selectSecondarySubtitleTrack(id | null)` enforces `secondary !== primary` (selecting the same track as primary clears secondary when primary switches to it, and ignores/rejects setting secondary equal to primary).
  - Reapplies `selectedSecondarySubtitleId` on recovery reloads and resets cleanly on item change.
- **Desktop `libmpv`:** wires `secondary-sid` + `secondary-sub-pos` (`10` at top of screen) so primary (bottom) and secondary (top) never collide; reports `selectedSecondarySubtitleId` in `MediaTracks` and sets `capabilities.dualSubtitles = true`.
- **Android Media3:** adds top-aligned `secondarySubtitleView` in `Media3SurfaceView.kt` (styled identically with `CaptionStyleCompat` & top padding), wires `selectSecondarySubtitleTrack` in `Media3Engine.kt` / `TrackSelectorBridge.kt` / `PlayerFactory.kt` (dual text cue routing for secondary tracks + external sidecar secondary tracks with isolated `StreamHttp` transport), sets `capabilities.dualSubtitles = true`.
- **Apple `AetherEngine`:** adds `secondaryCues` rendered strictly in the top-center slot (`.topCenter`) in `AetherSubtitleOverlayView.swift` (never overlapping primary bottom slots!), wires `selectSecondarySubtitleTrack` across `EngineCore+Tracks.swift`, `AetherBackend+Tracks.swift`, `ElvEngineAetherModule.swift`, and sets `capabilities.dualSubtitles = true`.
- **OSD Picker (`TrackPickerModal.tsx` & `PlayerSettingsSheet.tsx`):** exposes a capability-gated **"Secondary subtitle"** selector with `Off` + available tracks (marking/excluding the active primary track), full TV D-pad support, EN/TR localized.

---

## 5. `#223` — Android Media3 Native ASS/SSA OpenGL Subtitle Overlay
- Add `implementation "io.github.peerless2012:ass-media:0.6.0-beta01"` in `modules/engine-media3/android/build.gradle` (MIT-licensed wrapper targeting `androidx.media3:1.11.1`, dynamically packaging `libass.so` with `libass` ISC + `fribidi` LGPL-2.1 + `harfbuzz` MIT + `freetype` FTL; zero GPL).
- Add `AssOverlayBridge.kt` encapsulating `AssHandler(AssRenderType.OVERLAY_OPEN_GL)`, `AssRenderersFactory`, and `AssSubtitleView` behind a safe lifecycle guard (falling back cleanly to `SubtitleView` if JNI/OpenGL is unavailable on JVM Robolectric or headless environments).
- Mount `AssSubtitleView` inside `Media3SurfaceView.kt` above video and below `shutterView` (`isFocusable = false`), tearing down cleanly on zap, unbind, `stop()`, `recreate()`, and `release()` with zero GL texture/context leaks.
- Document `libass-android` (`0.6.0-beta01`, MIT / ISC / LGPL-2.1-or-later / FTL) in `packages/features/src/notices/notices-data.ts` and verify `tools/test/notices.test.ts`.

# Wave C4B Design Spec — Accessibility Typography, Text-Size Scale Audit, TV Remote Keys/Overscan & Ambient Clock (`#62`, `#163`, `#133`, `#416`)

## Scope
Completes Wave C4 and closes Parent Epic `#333`:
1. **`#62` — Text Size Setting Audit (`0.9x`–`1.2x`):** Ensure every list, grid, EPG guide, browse view, and player overlay scales row heights, headers, and controls deterministically from `theme.fontScale` with zero clipping or windowing/focus drift at the largest (`1.2x`) setting.
2. **`#163` — High-Legibility Accessibility Fonts (`Atkinson Hyperlegible Next` & `OpenDyslexic`):** Bundle `OFL-1.1` font binaries (verified 100% Turkish glyph coverage: `ğ, Ğ, ı, İ, ş, Ş, ç, Ç, ö, Ö, ü, Ü`), register notices via `tools/src/notices/native-notices.ts`, expose UI & subtitle font preferences in `@elv/domain`, wire UI typography in `@elv/ui-kit` + web `@font-face` + Expo config plugin (`with-accessibility-fonts.ts`), and wire native subtitle typefaces in Android Media3, Apple AetherEngine, and Desktop `mpv`.
3. **`#133` — TV Remote Color Keys, Overscan Insets & Remaining-Time HUD:** Add programmable color keys (`KEYCODE_PROG_RED/GREEN/YELLOW/BLUE`, keycodes `183–186`) to `@elv/focus-core`, `@elv/ui-kit`, and player/live remote bindings; add user-configurable TV horizontal & vertical overscan safe-area inset ratios (`overscanX`, `overscanY` in `0.00..0.10`, default `0.05`) wired through `ViewportProvider` and verified across all TV overlays (`PlayerOsd`, `PlayerChannelDrawer`, `NextEpisodeBanner`, `ToastHost`, `ConfirmDialog`); ensure remaining-time HUD readout & accessibility announcements clamp `>= 0` and align cleanly with playback speed.
4. **`#416` — Configurable Ambient TV Clock (`Always`, `Menus`, `Player`, `Never`):** Add persisted `tvClockMode` preference in `@elv/domain`, expose TV-only picker in Appearance settings, and render a quiet, tabular-nums, locale-aware (`Intl.DateTimeFormat`) minute-aligned clock (`AmbientTvClock`) on TV browse top chrome (`AdaptiveNavShell`) and TV Player OSD top-right corner (`PlayerOsdTopBar`), strictly ignored on non-TV form factors and never overlapping `PlayerStatsHud`.

## Architecture & Key Decisions

### 1. Domain Preferences & Focus Keys (`@elv/domain`, `@elv/focus-core`)
- **`@elv/domain` (`preferences-validators.ts`, `preferences.ts`):**
  - `AccessibilityFontFamily = 'system' | 'atkinson' | 'opendyslexic'`
  - `uiFontFamily: AccessibilityFontFamily` (default `'system'`)
  - `subtitleFontFamily: AccessibilityFontFamily` (default `'system'`)
  - `tvClockMode: TvClockMode` (`'always' | 'menus' | 'player' | 'never'`, default `'always'`)
  - `overscanX: number` (`0..0.1`, default `0.05`) and `overscanY: number` (`0..0.1`, default `0.05`) — clamped to `[0, 0.1]` and snapped cleanly to `0.01` increments.
  - Keep serialized preferences well within `MAX_PREFERENCES_BYTES = 4096`.
- **`@elv/focus-core` (`keys.ts`):**
  - Add `'colorRed' | 'colorGreen' | 'colorYellow' | 'colorBlue'` to `RemoteKey` (preserving `repeatCount == 0` filtering in `KeyForwarding.kt`).

### 2. High-Legibility Fonts & Licensing (`#163`)
- **Canonical Assets (`packages/ui-kit/assets/fonts/`):**
  - `AtkinsonHyperlegibleNext-Regular.ttf` (PS: `AtkinsonHyperlegibleNext-Regular`, Family: `Atkinson Hyperlegible Next`, OFL-1.1)
  - `AtkinsonHyperlegibleNext-Bold.ttf` (PS: `AtkinsonHyperlegibleNext-Bold`, Family: `Atkinson Hyperlegible Next`, OFL-1.1)
  - `OpenDyslexic-Regular.otf` (PS: `OpenDyslexic-Regular`, Family: `OpenDyslexic`, OFL-1.1)
  - `OpenDyslexic-Bold.otf` (PS: `OpenDyslexic-Bold`, Family: `OpenDyslexic`, OFL-1.1)
  - Plus `AtkinsonHyperlegibleNext-OFL.txt` and `OpenDyslexic-OFL.txt`.
- **Third-Party Notices (`tools/src/notices/native-notices.ts` + `pnpm notices:sync`):**
  - Add `collectAccessibilityFontNotices(repoRoot)` emitting `atkinson-hyperlegible-next` and `opendyslexic` (`OFL-1.1`, `platforms: ['Android', 'Android TV', 'Fire OS', 'iOS', 'iPadOS', 'tvOS', 'Windows', 'macOS', 'Linux']`) so `packages/features/src/notices/notices-data.ts` stays deterministic and `pnpm check` (`notices`) passes.
- **Native Asset Packaging (Zero external npm pods):**
  - `apps/tv-mobile/config/with-accessibility-fonts.ts`: Expo config plugin copying the 4 fonts into Android `app/src/main/assets/fonts/` and Apple `UIAppFonts` + Xcode `Resources` build phase (registered cleanly in `build-app-config.ts` & `build-app-config.test.ts`).
  - `apps/desktop`: fonts placed in `apps/desktop/resources/fonts/` (bundled via `electron-builder.yml` `extraResources` `{ from: resources/fonts, to: fonts }` for `win`/`mac`/`linux`) AND `apps/desktop/renderer/public/fonts/` (loaded via `@font-face` in renderer CSS / `index.html`).
- **UI Typography (`@elv/ui-kit`):**
  - `buildTheme` accepts `uiFontFamily?: AccessibilityFontFamily`.
  - When `'atkinson'` or `'opendyslexic'`, inject explicit per-weight `fontFamily` on every `theme.typography.*` token (on native: `'AtkinsonHyperlegibleNext-Bold'` for `fontWeight >= 600` and `'AtkinsonHyperlegibleNext-Regular'` otherwise, avoiding Android synthetic-bold blur; on web: `'Atkinson Hyperlegible Next', ...` / `'OpenDyslexic', ...` with `@font-face` mapping weight `400` and `700`).
- **Native Subtitle Renderers:**
  - **Android (`modules/engine-media3`):** Add `subtitleFontFamily` view prop on `Media3Surface` (`ElvEngineMedia3Module.kt` -> `Media3SurfaceView.kt`). Resolve & statically cache `Typeface.createFromAsset(context.assets, "fonts/...")` (`AtkinsonHyperlegibleNext-Regular.ttf` / `OpenDyslexic-Regular.otf`), apply via `CaptionStyleCompat` preserving OS caption colors/edge/window while resetting to `subtitleView.setUserDefaultStyle()` when `'system'`.
  - **Apple (`modules/engine-aether`):** Add `subtitleFontFamily` view prop on `AetherSurface` (`ElvEngineAetherModule.swift` -> `AetherSurfaceView.swift` -> `AetherSubtitleOverlayView.swift`). Map `'atkinson'` -> `'AtkinsonHyperlegibleNext-Regular'`, `'opendyslexic'` -> `'OpenDyslexic-Regular'`, overriding `captionStyle.fontName` when non-system (leaving `SystemCaptionAppearanceSource` intact for `'system'`).
  - **Desktop `mpv` (`apps/desktop`):** Resolve fonts directory (`process.resourcesPath/fonts` packaged, `apps/desktop/resources/fonts` dev), pass `--sub-fonts-dir=<fontsDir>` in `mpv/options.ts`, and forward `setSubtitleFontFamily(family)` IPC command (`['set_property', 'sub-font', 'Atkinson Hyperlegible Next' | 'OpenDyslexic' | 'sans-serif']`) cleanly from renderer preferences!

### 3. Text-Size Audit (`#62`), Overscan + Color Keys (`#133`), Ambient TV Clock (`#416`)
- **`#62` Fixed-Height Audit:** Scale row/header/card/overlay heights deterministically from `theme.fontScale` in:
  - `packages/features/src/shared/catalog-layout.ts` (`textAndPad` & `gridRowHeight`)
  - `packages/features/src/search/SearchScreen.tsx` (`rowHeight`)
  - `packages/features/src/live/LiveChannelsGrid.tsx` (`cardHeight` & row spacing)
  - `packages/features/src/live/EpgGridView.tsx` (`rowHeight`) & `EpgPreviewHeader.tsx` (`rulerRow` height)
  - `packages/features/src/browse/BrowseParts.tsx` (row height helper scaled by `theme.fontScale`)
  - `packages/features/src/player/PlayerSettingsSheet.tsx`, `PlayerChannelDrawer.tsx`, and `PlayerOsdTopBar.tsx` (`titleFontSize` & row pitches).
- **`#133` Color Keys, Overscan & Remaining-Time HUD:**
  - Map Android keycodes `183 -> colorRed`, `184 -> colorGreen`, `185 -> colorYellow`, `186 -> colorBlue` in `packages/ui-kit/src/tv/android-keys.ts` (and `KeyForwarding.kt` already forwards all non-system keycodes with `repeatCount == 0`; verify `183–186` are forwarded in `KeyForwardingTest.kt`!).
  - Wire color keys in `usePlayerControls.ts` (Red -> toggle subtitles / open tracks, Green -> audio track / tracks, Yellow -> sleep/info/stats, Blue -> channel drawer / EPG on live or info on VOD).
  - Pass `overscanX` & `overscanY` from preferences into `ViewportProvider` -> `resolveViewport(...)`, expose TV-only horizontal & vertical overscan controls in `AppearancePanel.tsx`, and verify TV floating overlays (`NextEpisodeBanner`, `PlayerChannelDrawer`, `ToastHost`, `ConfirmDialog`) respect `viewport.overscan.{x,y}`.
  - Ensure `vod-progress-math.ts` clamps remaining time strictly `>= 0` (including speed-adjusted remaining time when `playbackSpeed !== 1`) and `VodProgressBar.tsx` / `DesktopCinemaBar.tsx` announce clamped `>= 0` accessibility labels when toggled!
- **`#416` `AmbientTvClock`:**
  - New `packages/features/src/shared/AmbientTvClock.tsx`: renders ONLY when `viewport.formFactor === 'tv'` and `tvClockMode` permits (`surface: 'menus'` -> `'always' | 'menus'`; `surface: 'player'` -> `'always' | 'player'`).
  - Formats with `Intl.DateTimeFormat(locale, { timeStyle: 'short' })` + `TABULAR_NUMS_STYLE`, schedules updates strictly on next minute boundary (`60_000 - (now % 60_000) + 50`), cleans up timers on unmount/hide.
  - Mounted in `AdaptiveNavShell` top chrome trailing edge and `PlayerOsdTopBar` right cluster (overscan-safe, never overlapping `PlayerStatsHud`).

## Verification
- `pnpm check` passes `11 passed, 0 failed` (including `notices` parity and `>= 90%` coverage in pure packages).
- Android Media3 Gradle `:elv-engine-media3:testDebugUnitTest` & `elv-remote-keys` tests pass (`BUILD SUCCESSFUL`).
- Apple Swift 6 `swift test` on `elv-mac` passes cleanly.
- Independent whole-branch review (`VERDICT: PASS`) and full green GitHub CI.
- Merging Wave C4B closes `#62`, `#163`, `#133`, `#416` AND marks Parent Epic `#333` 100% complete (auto-closed)!

# UI & Platform Foundation Design (Round 2 Core)

- **Date:** 2026-11-20
- **Status:** Accepted
- **Scope:** Shared, feature-agnostic UI and runtime foundation preceding Round 2 (`0.2`) screen implementation across Android TV, Fire OS, Android phone/tablet, Apple TV (tvOS), iPhone/iPad, Windows, macOS, and Linux.
- **Refs:** `#16`, `#79`, `#112`, `#130`, `#136`, `#138`, `#139`, `#146`, `#152`, `#159`, `#186`, `#219`, `#277`, `#281`, `#311`, `#325`, `#333`

## 1. Goals & Non-Goals

### Goals
1. Establish a single, extensible **Cinema Quietude** design system in `@elv/ui-kit` (`ThemeProvider`, 6 built-in presets including WCAG AAA High Contrast, dynamic scrim/glass derivation, responsive viewport/orientation/modality hook, pluggable platform visual adapters, vector icon registry, core primitives, and TV-navigable error boundary) so future screens never hardcode colors, layout breakpoints, or platform workarounds.
2. Provide a zero-install **hot-reload UI Workbench (`pnpm dev:ui`)** running the real `@elv/ui-kit` + `@elv/features` code in the browser across TV, Phone (Portrait/Landscape), Tablet, and Desktop viewports, plus an unpackaged **Electron Metro Fast Refresh** dev mode (`ELV_DEV_SERVER_URL`) without weakening production `app://elv/` security.
3. Harden the shared **TV Focus / Input** and **Thin Preferences / SQLite** base (`TVRemoteDispatcher`, empty-list focus recovery, input/modal hygiene, tvOS-500KB-safe `PreferencesStore`, `openCatalog` schema self-heal + WAL batch yield) before feature tables and multi-region screens are added.
4. Upgrade `@elv/features`'s `AppShell` to a **config-driven, extensible adaptive navigation shell** (`destinations: readonly NavDestination[]`, `utilities: readonly NavUtility[]`) that preserves all working `0.1` screens without regression.

### Non-Goals (Deferred Just-In-Time to Each Feature Slice)
- Feature-specific tables or screens: EPG ingestion/grid (`#6`, `#25`, `#113`, `#250`), FTS5 search (`#149`), watch progress / favorites (`#14`, `#201`), Home/Movies/Series/Detail redesigns, and Desktop in-canvas video overlay (`#95`, scheduled immediately before Player OSD / Live TV UI).
- Third-party native Expo UI packages inside `@elv/ui-kit` (forbidden by spec §5.2; optional native renderers inject through `UiAdaptersProvider` from app composition roots).

## 2. Four-PR Delivery Sequence

| PR | Branch | Scope |
| :--- | :--- | :--- |
| **PR 1** | `feat/ui-design-system-core` | Living `UI_UX_PHILOSOPHY.md` update + `@elv/ui-kit` Theme/Tokens (`#325`, `#333`), `ViewportProvider` / `useViewport()` (`#281`), `UiAdaptersProvider`, SVG `Icon` registry, `Surface`, `Scrim`, `GlassBar`, `CtaButton`, `IconButton`, `MicroPill`, `FilterChip`, `ArtworkImage` (`#202`, `#311`), `PosterCard`, `WideCard`, `AdaptiveSheet`, `ErrorBoundary` (`#159`). |
| **PR 2** | `feat/ui-hot-reload-workbench` | Dev-only `pnpm dev:ui` interactive Workbench (real React Native Web code, device/orientation/overscan/theme/locale switchers, synthetic catalog + design gallery) + unpackaged Electron `ELV_DEV_SERVER_URL` localhost Metro Fast Refresh. |
| **PR 3** | `fix/focus-input-and-data-base` | `TVRemoteDispatcher` (`#277`), empty-panel focus recovery + `TvList` scroll sync (`#112`, `#152`, `#186`), modal/hotkey/IME/touch-hover guards (`#130`, `#136`, `#139`), thin tvOS-safe `PreferencesStore` (`#16`, `#79`), `openCatalog` column verification + batch yield + atomic delete (`#138`, `#146`, `#219`), plus `tools/src/exec.ts` (`killPosixGroup`) and `catalog-worker-runtime.test.ts` flake fixes. |
| **PR 4** | `feat/adaptive-modular-app-shell` | Config-driven `AdaptiveNavShell` (`NavDestination[]` + `NavUtility[]`) in `@elv/features` wired to `ThemeProvider`, `ViewportProvider`, `PreferencesStore`, live `I18nProvider` (`#16`), and `ErrorBoundary` across `apps/tv-mobile` and `apps/desktop/renderer`. |

## 3. PR 1 Detailed Contracts (`@elv/ui-kit`)

### 3.1 Theme & Token Engine (`src/theme/`)
- `ThemePalette`: semantic color roles (`accent`, `accentSecondary`, `accentContrast`, `bgCanvas`, `bgSurface`, `bgCard`, `bgElevated`, `bgRail`, `textPrimary`, `textSecondary`, `textMuted`, `focusRingColor`, `liveColor`, `successColor`, `ctaBg`, `ctaFg`).
- `THEME_PRESETS`: `obsidianCrimson` (default), `abyssalSapphire`, `theaterAmber`, `velvetViolet`, `pitchEmerald`, `highContrast` (WCAG AAA: `#000000` canvas, `#FFFFFF` text, `#FACC15` focus ring). Custom palettes may be passed directly via `ThemeProvider` without modifying the registry.
- Dynamic derived surfaces (`buildTheme`): computes `scrimStrong`, `scrimMedium`, `scrimSoft`, `glassBg`, `glassBorder`, `surfaceBorder`, `overlayBackdrop`, `focusFill` via pure `hexToRgba` from `bgCanvas`, `bgElevated`, and `textPrimary` — zero hardcoded dark-blue hexes.
- Contrast invariants (verified in unit tests):
  - All 6 presets satisfy `contrastRatio(textPrimary, bgCanvas) >= 7.0` and `contrastRatio(ctaFg, ctaBg) >= 7.0` and `contrastRatio(textSecondary, bgCanvas) >= 4.5`.
  - `highContrast` satisfies `>= 7.0` (WCAG AAA) across `textPrimary`, `textSecondary`, `textMuted`, `accent`, and `focusRingColor` on `bgCanvas`.
- Typography & Geometry:
  - `radius: { button: 4, card: 6, modal: 12, pill: 999 }`, `spacing: { xxs: 4, xs: 6, sm: 10, md: 16, lg: 24, xl: 32, xxl: 48, gridGap: 6 }`.
  - `fontScale` clamped to `[0.9, 1.2]` (default `1.0`); `motion` durations (`fastMs: 150`, `normalMs: 220`, `sheetMs: 280`) collapse to `0` when `reduceMotion` is true.
  - `TABULAR_NUMS_STYLE` (`fontVariant: ['tabular-nums']`) exported for timestamps, durations, channel numbers, and ratings.

### 3.2 Adaptive Viewport (`src/viewport/` + `src/form-factor.tsx`)
- `ViewportInfo`:
  - `formFactor: 'tv' | 'phone' | 'tablet' | 'desktop'`
  - `orientation: 'portrait' | 'landscape'`
  - `inputModality: 'tv' | 'pointer' | 'touch'`
  - `width`, `height`, `safeArea: { top, right, bottom, left }`
  - `overscan: { x, y }` (`5%` on `tv`, `0` elsewhere)
  - `columns: { posterRail, wideRail, categoryGrid }` (matching `UI_UX_PHILOSOPHY.md` §3)
  - `tvScale: number` (normalizes `960x540dp` Android TV vs `1920x1080pt` tvOS via `clamp(width / 1920, 0.5, 1.5)` on `tv`, `1` elsewhere; `#281`).
- `ViewportProvider` accepts partial overrides (used by tests and `pnpm dev:ui` device preview) and also provides `FormFactorContext` so existing `useFormFactor()` consumers remain 100% compatible.

### 3.3 Pluggable Platform Adapters (`src/adapters/`)
- `UiAdapters` (`renderGradient?`, `renderBlur?`, `renderImage?`, `renderSvg?`) provided via `UiAdaptersProvider`.
- Default implementations require zero native modules:
  - Web: CSS `linear-gradient`, `backdropFilter: 'blur(20px)'`, inline `<svg>`, standard `Image`.
  - Native: layered translucent canvas stops, elevated translucent glass bar, accessible fallback / `Image` with decode-size hints.

### 3.4 Core Primitives (`src/icons/`, `src/primitives/`)
- `Icon`: 28+ typed `IconName` vector shapes in `src/icons/paths.ts` (`viewBox="0 0 24 24"`).
- `Surface`, `Scrim`, `GlassBar`, `CtaButton`, `IconButton`, `MicroPill`, `FilterChip`.
- `ArtworkImage`: `DeadHostRegistry` circuit breaker (`#202`, opens after 3 consecutive host load errors within a session with bounded host map and reset helper), decode cap (`maxDecodePx`, `#311`), optional dark-mode logo readability plate (`#126`), clean monogram/tonal placeholder on failure or missing URI.
- `PosterCard` (`2:3` default, configurable aspect) & `WideCard` (`16:9` Continue Watching / Live with optional progress bar and LIVE pill): zero boxed containers, zero duplicate titles, crisp TV `focusRingColor` + `1.05x` scale (suppressed under `reduceMotion`).
- `AdaptiveSheet`: non-`Modal` focus-scoped overlay (Biome `no-tv-modal` safe!) rendering as right-anchored floating popover (`300px`) in Landscape and slide-up bottom sheet (`10px` inset + grab handle) in Portrait.
- `ErrorBoundary`: React error boundary displaying a themed, TV-focusable recovery view with retry action (`#159`).

## 4. Verification
- Pure Jest + RNTL tests under `packages/ui-kit/src/**/__tests__/*.test.{ts,tsx}` covering theme contrast ratios, derived scrim/glass math, `resolveViewport` across all 4 form factors and orientations, `DeadHostRegistry`, every primitive across default + `highContrast` + `reduceMotion` + TV/Portrait/Landscape, and `ErrorBoundary` recovery.
- Full `pnpm check` (`11 passed, 0 failed`) including `biome`, `typecheck`, `deps`, `knip`, `file-size`, `vitest`, `jest`.

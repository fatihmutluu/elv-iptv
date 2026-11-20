# ui-kit (`@elv/ui-kit`)

React components for react-native and react-native-web, design tokens and TV focus primitives.

## Commands
- `pnpm --filter @elv/ui-kit typecheck` type-checks this package.
- `pnpm --filter @elv/ui-kit test:jest` runs its Jest component tests.
- `pnpm -w check` runs every repository check.

## Rules
- **UI/UX Contract (mandatory):** Read `docs/design/UI_UX_PHILOSOPHY.md` before changing tokens, themes, surfaces, focus states, buttons, cards, or layout primitives. Colors, scrims, and focus states must read dynamically from the theme provider (including WCAG AAA High Contrast).
- May import `react` and `react-native`; never `expo-*`, navigation libraries, or `electron`. Allowed workspace deps: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`. Never imports `features`, `modules/*`, or `apps/*`. Source-first (`src/index.ts`).
- Layout forks happen via `useViewport()` (which also keeps `useFormFactor()` in sync via `ViewportProvider`/`FormFactorProvider`), never by file-name suffix. `I18nProvider`/`useI18n` subscribe to `@elv/i18n` via `useSyncExternalStore`.
- TV code never uses `Modal` (Biome enforces it); overlays (`AdaptiveSheet`) are focus-scoped views in the main window.

## Design System Core (`src/theme/`, `src/viewport/`, `src/adapters/`, `src/icons/`, `src/primitives/`)
- **Theme (`src/theme/`):** `ThemeProvider`, `useTheme`, `useThemeController`, `buildTheme`, `THEME_PRESETS` (`obsidianCrimson`, `abyssalSapphire`, `theaterAmber`, `velvetViolet`, `pitchEmerald`, WCAG AAA `highContrast` #325), `contrastRatio`, `hexToRgba`, `clampFontScale` (`[0.9, 1.2]`), `TABULAR_NUMS_STYLE`. Scrims/glass/surfaces derive dynamically; `reduceMotion` collapses durations to `0` and focus scale to `1.0`.
- **Viewport (`src/viewport/`):** `ViewportProvider`, `useViewport`, `resolveViewport` return `{ formFactor, orientation, inputModality, width, height, safeArea, overscan, columns, tvScale }` normalizing Android TV vs Apple TV (#281).
- **Adapters & Icons (`src/adapters/`, `src/icons/`):** `UiAdaptersProvider`/`useUiAdapters` inject optional native `renderGradient`/`renderBlur`/`renderImage`/`renderSvg`. `Icon` renders 36 typed `IconName` specs from `ICON_PATHS`.
- **Primitives (`src/primitives/`):** `Surface`, `Scrim`, `GlassBar`, `ArtworkImage` + `DeadHostRegistry` (#126, #202, #311), `AdaptiveSheet`, `ErrorBoundary` (#159), `CtaButton`, `IconButton`, `MicroPill`, `FilterChip`, `PosterCard` (`2:3`), `WideCard` (`16:9`). Zero boxed media cards, zero duplicate titles, zero neon desktop hover rings.

## TV focus, remote dispatcher & lists (`src/tv/`, `src/list/`)
- **Dispatcher (`remote-dispatcher.ts`, `key-source.ts`):** `TvRemoteProvider`/`createTvRemoteDispatcher`/`TvRemoteContext` (#277) attach one root platform listener (`TVEventHandler` + refcounted `TVEventControl` + `BackHandler`, Android raw `RemoteKeysProvider`, or web DOM `keydown`/`keyup`/`blur`) with throwing-subscriber isolation and support for `TextEntryBoundary` above or below the provider. `useTvKeySource` subscribes to the shared dispatcher inside `TvRemoteProvider` and falls back directly outside it.
- **Input guards (`web-keys.ts`, `touch-hover-guard.ts`, `TvFocusAnchor.tsx`):** `subscribeWebKeys` drops IME composition (`isComposing`, `Process`, `keyCode === 229`), auto-repeats, and modifiers while preserving native editing (`Escape` blurs); `isEditableWebTarget` detects `INPUT`/`TEXTAREA`/`SELECT`, `contentEditable`, and ARIA `textbox`/`searchbox`/`combobox` (#136, #139). `createTouchHoverGuard(windowMs = 600)` suppresses synthetic post-touch hover (#139). `TvFocusAnchor` renders a 1×1 transparent focusable `View` so empty/loading tvOS screens retain focus (#186).
- **Key interpreter & text entry (`android-keys.ts`, `use-key-interpreter.ts`, `text-entry.tsx`):** `createAndroidKeyAdapter` preserves real tap/hold timestamps across JS stalls; `useKeyInterpreter` coalesces repeats with rAF ack; `TvTextInput`/`TextEntryBoundary`/`useTextEntrySuspension` (#48) suspend non-`back` keys during editing and exit on short `back`.
- **Lists (`TvList.tsx`, `list-source.ts`, `src/list/ElvList.tsx`):** `TvList` windows `visibleRows + 4` memoized slots anchored every `512 * pool` rows; only single-row non-held steps with `!reduceMotion` run `Animated.timing` — jumps, holds, source swaps, and `reduceMotion` call `stopAnimation()` before `setValue` (#152). `ElvList` delegates to `TvList` on `'tv'` and `VirtualizedList` elsewhere.

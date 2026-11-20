# ui-kit (`@elv/ui-kit`)

React components for react-native and react-native-web, design tokens and TV focus primitives.

## Commands
- `pnpm --filter @elv/ui-kit typecheck` type-checks this package.
- `pnpm --filter @elv/ui-kit test:jest` runs its Jest component tests.
- `pnpm -w check` runs every repository check.

## Rules
- **UI/UX Contract (mandatory):** Read `docs/design/UI_UX_PHILOSOPHY.md` before creating or modifying any token, theme preset, surface, focus style, button, card, or layout primitive. All colors, scrims, and focus states must read dynamically from the theme token provider (including WCAG AAA High Contrast).
- May import `react` and `react-native`; never `expo-*`, navigation libraries or `electron`.
- Allowed workspace dependencies: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`.
- Never imports `features`, `modules/*` or `apps/*`. Source-first (`exports` points at `src/index.ts`).
- Layout forks happen in container components via `useViewport()` (which also keeps legacy `useFormFactor()` in sync via `ViewportProvider` / `FormFactorProvider`: `'tv' | 'phone' | 'tablet' | 'desktop'`), never by file-name suffix.
- Localization hooks (`I18nProvider`, `useI18n`) subscribe to `@elv/i18n`'s pure `AppI18n` via `useSyncExternalStore`.
- TV code never uses `Modal` (Biome enforces it); overlays (`AdaptiveSheet`) are focus-scoped views in the main window.

## Design System Core (`src/theme/`, `src/viewport/`, `src/adapters/`, `src/icons/`, `src/primitives/`)
- **Theme tokens (`src/theme/`):** `ThemeProvider`, `useTheme`, `useThemeController`, `buildTheme`, `THEME_PRESETS` (6 presets: `obsidianCrimson`, `abyssalSapphire`, `theaterAmber`, `velvetViolet`, `pitchEmerald`, and WCAG AAA `highContrast` #325), `contrastRatio`, `hexToRgba`, `clampFontScale` (`[0.9, 1.2]`), and `TABULAR_NUMS_STYLE`. Scrims, glass, focus fills, and surfaces derive dynamically from `bgCanvas`/`bgElevated` — zero hardcoded dark-blue hexes. `reduceMotion` collapses transition durations to `0` and focus scaling to `1.0`.
- **Viewport (`src/viewport/`):** `ViewportProvider`, `useViewport`, `resolveViewport` return `{ formFactor, orientation, inputModality, width, height, safeArea, overscan, columns, tvScale }` — normalizing Android TV (`960×540`) vs Apple TV (`1920×1080`) metrics (#281) and propagating `formFactor` overrides into `FormFactorProvider` automatically.
- **Native adapters (`src/adapters/`):** `UiAdaptersProvider` / `useUiAdapters` let composition roots inject optional native `renderGradient`, `renderBlur`, `renderImage`, and `renderSvg` renderers without pulling `expo-*` into `@elv/ui-kit`.
- **Icons (`src/icons/`):** `Icon` renders typed `IconName` paths from `ICON_PATHS` (`paths.ts`, 36 single-weight stroke/filled specs) via `UiAdapters.renderSvg` on native or inline `<svg>` on web.
- **Primitives (`src/primitives/`):** `Surface`, `Scrim`, `GlassBar`, `ArtworkImage` + `DeadHostRegistry` (#126, #202, #311), `AdaptiveSheet`, `ErrorBoundary` (#159), `CtaButton`, `IconButton`, `MicroPill`, `FilterChip`, `PosterCard` (`2:3` pure artwork), `WideCard` (`16:9` Live / Continue Watching). Zero outer boxes around media cards, zero duplicate titles, zero neon desktop hover rings.

## TV list, key source and text-entry suspension (`src/tv/`)
- `TvRemoteProvider` / `createTvRemoteDispatcher` / `TvRemoteContext` (#277) attach one root platform key listener
  (`TVEventHandler` + refcounted `TVEventControl` + `BackHandler`, Android raw `RemoteKeysProvider`, or web DOM
  `keydown`/`keyup`/`blur`) and fan out `{ input, requirePriorDown }` to active subscribers with throwing-subscriber
  isolation and support for `TextEntryBoundary` mounted above or below the provider. `useTvKeySource(onInput)` subscribes
  to the shared dispatcher when inside `TvRemoteProvider` and falls back to a direct platform listener outside it.
- Web keyboard guards (#136, #139): `subscribeWebKeys` drops IME composition events (`isComposing`, `Process`,
  `keyCode === 229`), auto-repeats, and modifier shortcuts, while letting editable targets edit text (`Escape` blurs).
  `isEditableWebTarget(target)` detects `<input>`/`<textarea>`/`<select>`, `contentEditable` (`true`/`plaintext-only`),
  and ARIA `textbox`/`searchbox`/`combobox` roles for reuse by desktop/feature hotkeys.
- `createTouchHoverGuard(windowMs = 600)` (#139) suppresses synthetic post-touch hover events on hybrid devices,
  handling non-monotonic timestamps and `windowMs <= 0`.
- `TvFocusAnchor` (#186) renders a 1×1 transparent focusable `View` (`hasTVPreferredFocus` default `true`,
  `accessible={false}`, `pointerEvents="none"`) so empty/loading TV screens retain focus and Menu/Back never fall
  through to tvOS home.
- `createAndroidKeyAdapter` tracks active `keyCode`s per `Key` and `{ rawDownAt, reportedDownAt }` so JS stalls never
  turn a short tap into `long` or crush a real hold into `press`. Standalone `BackHandler` events without a preceding
  raw `KEYCODE_BACK` cycle synthesize `{ key: 'back', action: 'press' }`.
- `useKeyInterpreter(onEvent, opts?)` pairs `useTvKeySource` with `createKeyInterpreter`, tracks `pendingKeys: Set<Key>`
  with rAF acknowledgement, and skips 1 tick when `now - lastTickAt > 100` so queued releases drain before `long` fires.
- Text-entry suspension (#48): `TvTextInput`, `TextEntryBoundary`, and `useTextEntrySuspension` cancel held non-`back`
  keys on entry, suppress all non-`back` keys while active, blur/exit on short `back` (`< 500ms`) without dispatching
  `back` to `FocusStore`, pass long `back` (`backLong`) through, and drop orphan releases on mid-hold exit.
- `TvList` is a windowed vertical list (`visibleRows + 4` slots; slot `i % pool` hosts item `i`, passing `item` directly
  to memoized `<Row>` and quantizing `source.prefetch` by `max(1, pool >> 1)`). It subscribes to both `index` and
  `store.isActive(listId)`, suppressing `<FocusRing />` (`pointerEvents="none"`, `accessible={false}`) and row
  `selected` state when inactive or empty (`count <= 0`), and clamping `safeIndex` and `safeFocusLine`.
- Coordinates anchor every `512 * pool` rows; only single-row steps (`|delta| === 1` on the same `source`, when not
  held and `useTheme().reduceMotion` is `false`) animate with `Animated.timing`, while jumps, holds, source swaps, and
  `reduceMotion` call `stopAnimation()` before snapping via `setValue` (#152).
- `onFrameCommitted(index, window)` fires on the first animation frame after a focused-index commit.
- `createSyntheticSource(count, make, cacheSize)` computes items on demand with a small LRU.
- `ElvList` (`src/list/ElvList.tsx`) wraps `ListSource<T>` across form factors: delegates to `TvList` on `'tv'`
  (syncing `FocusStore` list index with `selectedIndex` / `onSelectIndex` without stealing active focus) and renders
  a fixed-height `VirtualizedList` (`getItemLayout`, windowed prefetch, `initialScrollIndex` restoration, and desktop
  `ArrowUp`/`ArrowDown`/`PageUp`/`PageDown`/`Enter` keys) on `'phone' | 'tablet' | 'desktop'`.

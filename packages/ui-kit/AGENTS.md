# ui-kit (`@elv/ui-kit`)

React components for react-native and react-native-web, design tokens and TV focus primitives.

## Commands
- `pnpm --filter @elv/ui-kit typecheck` type-checks this package.
- `pnpm -w check` runs every repository check.

## Rules
- May import `react` and `react-native`; never `expo-*`, navigation libraries or `electron`.
- Allowed workspace dependencies: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`.
- Never imports `features`, `modules/*` or `apps/*`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Layout forks (TV, phone, tablet, desktop) happen in a few container components chosen by an
  explicit form-factor value, never by file-name suffix.
- Component tests use Jest with `jest-expo` and `@testing-library/react-native`
  (`*.test.tsx` beside the component). The `test:jest` script and the Jest dev dependencies mirror
  `apps/tv-mobile`; `pnpm check` runs it.

## TV list and key source (`src/tv/`)
- `useTvKeySource(onInput)` is the only place that touches `TVEventHandler`, `TVEventControl` and `BackHandler`.
  It receives keys only while a native view is focused: a TV screen needs a focusable root (`focusable` plus
  `hasTVPreferredFocus`), or Android delivers no remote keys at all (also not `adb shell input keyevent`).
  `toKeyInput` maps remote events to focus-core `KeyInput`: `eventKeyAction` 0/1 (Android) become `down`/`up`, events
  without it (tvOS) become `press`, `long*` events (`longSelect`, `longDown`, ...) become one `long`,
  `pageUp`/`pageDown` become `channelUp`/`channelDown`; swipes, pans and unknown types give `undefined`. On Android TV
  (react-native-tvos 0.88, verified) a tap arrives only as its release, so latency counts from it; a hold arrives as
  `long<Key>` 0, then `long<Key>` 1 at the release (dropped), no repeats (`android-remote.test.tsx` replays both).
  Android Back comes through `BackHandler` (consumed) as a `back` press; a long Back is not observable there (`backLong`
  on Android is deferred to #7). On tvOS the menu key is enabled while mounted and Menu (also a native long Menu) is
  `back`; Android KEYCODE_MENU stays `menu`. `toKeyInput` takes the platform explicitly (`'ios' | 'android'`). Feed the inputs to a focus-core key interpreter and the focus store.
- `TvList` is a windowed vertical list driven only by a `FocusStore` (rows never use `onPress`). It renders
  `visibleRows + 4` slots; slot `i % pool` hosts item `i`, so a step re-renders the entering slot plus the rows losing
  and gaining focus (at most 3), whatever the pool size. The viewport slides with a native-driven `Animated.Value`
  (short timing for single steps, direct `setValue` when changes arrive within 150 ms, i.e. held keys).
  `renderRow` and `rowLabel` must be stable (module-level or `useCallback`): an inline one defeats the row memo.
- Mid-list the focused item sits on `focusLine` (default 2) and the ring top is `focusLine * rowHeight`. At the top and
  bottom the window cannot slide (it is clamped to `[0, count - visibleRows]`), so the ring leaves the line there.
- Native coordinates stay bounded: row tops and the content translate are relative to an anchor row that moves every
  `8 * pool` rows (all rows re-render once then), so 100,000 rows never reach float32 limits. The offset syncs on
  `windowStart`/`rowHeight`/anchor changes (jumping, not animating, unless it is a plain step); `source.prefetch` is called
  with the rendered range plus one pool of margin when that range moves; `rowLabel` sets each row's accessibility label.
- Key stamps use `performance.now()`.
- `onFrameCommitted(index, window)` fires once per focused-index change, on the first animation frame after the row and ring
  committed, with the `FrameWindow` it showed (visible `[start, end)`, rendered `[renderedStart, renderedEnd)`); an A to B to A change
  within one frame fires nothing; the gate uses it to measure key-to-highlight latency.
- Rows get `testID` `${testID}-row-${index}` and `accessibilityState.selected`; the ring is `${testID}-ring`.
- `createSyntheticSource(count, make, cacheSize)` computes items on demand with a small LRU, for gates and tests.
- Jest is wired (`jest.config.cjs`, `babel.config.cjs`, `pnpm --filter @elv/ui-kit test:jest`). `jest-expo` is a test
  preset only; source never imports `expo*`.

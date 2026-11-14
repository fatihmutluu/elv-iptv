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
  Key stamps use `performance.now()`. Android raw path: an app injects an `AndroidKeySource` through
  `RemoteKeysProvider`; the hook then skips `TVEventHandler` and feeds raw down/up via `createAndroidKeyAdapter`
  (orphan releases dropped, blur cancels held keys, age back-dating capped at 100 ms), whichever native view has
  focus; `BackHandler` only consumes Back (it arrives as raw down/up). A source change or unmount cancels held keys.
  While a native text field has focus hardware D-pad keys still arrive; a text-entry mode suspending them is #48.
- `TVEventHandler` path (tvOS; Android without a source or with `null`): keys arrive only while a native view is
  focused (focusable root with `hasTVPreferredFocus`). `toKeyInput` (takes `'ios' | 'android'`): `eventKeyAction` 0/1
  `down`/`up`, none (tvOS) `press`, `long*` one `long`, `pageUp`/`pageDown` `channelUp`/`channelDown`, swipes and
  unknowns `undefined`. Android TV (0.88): a tap arrives only as its release, a hold as `long<Key>` 0 then 1 (dropped),
  Back as a consumed `back` press. tvOS: menu key enabled while mounted, Menu (and long Menu) is `back`. TV code never
  uses `Modal` (Biome enforces it); overlays are focus-core scopes in the main window.
- `TvList` is a windowed vertical list driven only by a `FocusStore` (rows never use `onPress`). It renders
  `visibleRows + 4` slots; slot `i % pool` hosts item `i`, so a step re-renders the entering slot plus the rows losing
  and gaining focus (at most 3), whatever the pool size. The viewport slides with a native-driven `Animated.Value`
  (short timing for single steps, direct `setValue` when changes arrive within 150 ms, i.e. held keys).
  `renderRow` and `rowLabel` must be stable (module-level or `useCallback`): an inline one defeats the row memo.
- Mid-list the focused item sits on `focusLine` (default 2) and the ring top is `focusLine * rowHeight`. At the top and
  bottom the window cannot slide (it is clamped to `[0, count - visibleRows]`), so the ring leaves the line there.
- Native coordinates stay bounded: row tops and the content translate are relative to an anchor row that moves every
  `8 * pool` rows (all rows re-render once then), so 100,000 rows never reach float32 limits. The offset syncs on
  `windowStart`/`rowHeight`/anchor changes (jumping, not animating, unless it is a plain step); `source.prefetch` gets
  the rendered range plus one pool of margin when that range moves; `rowLabel` sets each row's accessibility label.
- `onFrameCommitted(index, window)` fires once per focused-index change, on the first animation frame after the row
  and ring committed, with its `FrameWindow` (visible `[start, end)`, rendered `[renderedStart, renderedEnd)`);
  an A to B to A change within one frame fires nothing; the gate uses it to measure key-to-highlight latency.
- Rows get `testID` `${testID}-row-${index}` and `accessibilityState.selected`; the ring is `${testID}-ring`.
- `createSyntheticSource(count, make, cacheSize)` computes items on demand with a small LRU, for gates and tests.
- Jest is wired (`jest.config.cjs`, `babel.config.cjs`, `pnpm --filter @elv/ui-kit test:jest`). `jest-expo` is a test
  preset only; source never imports `expo*`.

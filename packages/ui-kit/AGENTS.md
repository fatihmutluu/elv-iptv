# ui-kit (`@elv/ui-kit`)

React components for react-native and react-native-web, design tokens and TV focus primitives.

## Commands
- `pnpm --filter @elv/ui-kit typecheck` type-checks this package.
- `pnpm --filter @elv/ui-kit test:jest` runs its Jest component tests.
- `pnpm -w check` runs every repository check.

## Rules
- May import `react` and `react-native`; never `expo-*`, navigation libraries or `electron`.
- Allowed workspace dependencies: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`.
- Never imports `features`, `modules/*` or `apps/*`. Source-first (`exports` points at `src/index.ts`).
- Layout forks happen in container components via `useFormFactor()` (`FormFactorProvider` / `detectFormFactor`: `'tv' | 'phone' | 'tablet' | 'desktop'`), never by file-name suffix.
- Localization hooks (`I18nProvider`, `useI18n`) subscribe to `@elv/i18n`'s pure `AppI18n` via `useSyncExternalStore`.
- TV code never uses `Modal` (Biome enforces it); overlays are focus-core scopes in the main window.

## TV list, key source and text-entry suspension (`src/tv/`)
- `useTvKeySource(onInput)` owns `TVEventHandler`, refcounted `TVEventControl`, `BackHandler`, Android raw
  `RemoteKeysProvider`, and `Platform.OS === 'web'` DOM `keydown`/`keyup`/`blur` (dropping `event.repeat` and letting
  HTML `<input>`/`<textarea>` edit text; `Escape` blurs).
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
- Coordinates anchor every `512 * pool` rows; only single-row steps (`|delta| === 1` on the same `source`) animate with
  `Animated.timing`, while page jumps and source swaps snap via `setValue`.
- `onFrameCommitted(index, window)` fires on the first animation frame after a focused-index commit.
- `createSyntheticSource(count, make, cacheSize)` computes items on demand with a small LRU.
- `ElvList` (`src/list/ElvList.tsx`) wraps `ListSource<T>` across form factors: delegates to `TvList` on `'tv'`
  (syncing `FocusStore` list index with `selectedIndex` / `onSelectIndex` without stealing active focus) and renders
  a fixed-height `VirtualizedList` (`getItemLayout`, windowed prefetch, `initialScrollIndex` restoration, and desktop
  `ArrowUp`/`ArrowDown`/`PageUp`/`PageDown`/`Enter` keys) on `'phone' | 'tablet' | 'desktop'`.

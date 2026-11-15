# Plain Browse Menu (Live, Movies, Series) and Cross-Platform Player Screen — Design

- Status: approved (owner delegated all development decisions until `0.1` ships)
- Date: 2026-11-15
- Issue: #13 (plain menu: Live, Movies, and Series with categories, seasons, and episodes; closes alongside #5 once tvOS list gate baseline is recorded).
- Builds on: Foundation Spec (`2026-11-13-foundation-design.md` §1.4, §5.2–§5.7, §6.2), Sources UI & Localization Spec (`2026-11-15-sources-ui-design.md`), Player Core Spec (`2026-11-14-player-core-design.md`), Desktop Player Spec (`2026-11-14-desktop-player-design.md`), ADR 0004 (focus core).

## 1. Why

With on-device SQLite catalogs (`#72`, `#75`), native playback engines (`#88`, `#96`, `#7`), LGPL FFmpeg audio (`#69`), localization (`@elv/i18n`), `useFormFactor()`, and source management (`#71`, `#10`) in place, Version `0.1` needs the deliberately plain browse-and-play shell that connects them: browsing **Live**, **Movies**, and **Series** (categories, 25k–100k items without lag, on-demand Xtream seasons/episodes), launching playback on any item across TV remote, touch, and desktop mouse/keyboard, zapping live channels, releasing the stream when backgrounded (`Home` on TV), stopping playback if its source is removed, and returning to the exact focused row on `Back`.

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Top-level navigation across **Live**, **Movies**, **Series**, and **Sources** (`AppShell`), defaulting to `Sources` when no source exists yet and automatically importing any `needsImport` sources (such as Apple manifest-restored sources after a cache purge).
- Lag-free browsing of 25,000–100,000+ item categories on every platform through an LRU-paged `ListSource<ItemRow>` (`pageSize = 200`, `maxPages = 16`) and a unified `ElvList<T>` in `@elv/ui-kit` (`TvList` on `'tv'`; fixed-height `VirtualizedList` over `ListSource<T>` on `'phone' | 'tablet' | 'desktop'`).
- Full Series drilldown: category -> series -> seasons (`CatalogService.seasons(seriesId)`, triggering `loadSeriesEpisodes` on first visit with loading and retryable error states) -> episodes (`CatalogService.episodes(seriesId, season)`) -> episode playback.
- Cross-platform `PlayerScreen` in `@elv/features` over injected `VideoHost` and `AppLifecyclePort` ports:
  - Creates and disposes the engine in `useEffect` / `useRef` (never inside `useMemo`), handling both synchronous (`Media3`, `Aether`) and asynchronous (`DesktopEngine`) engine creation with unmount cancellation.
  - Stops playback and releases the provider HTTP connection when the app enters `'background'` (e.g., pressing `Home` on Android TV or Apple TV) and re-tunes cleanly when returning to `'active'`.
  - Connects `PlaybackGuard` so removing a source in `Sources` stops any active stream from that source immediately.
  - Supports live channel Up/Down zapping within the active category and restores the exact category, scroll offset, and focused item index on `Back`.
- Complete English (`en`) and Turkish (`tr`) Lingui strings for all menu, series, and player states/errors, and deterministic semantic `testID`s on every focusable element.

### Non-Goals
- Artwork, channel logos, posters, custom themes, or visual polish (Round 2 design language).
- EPG programme guide grid (#6, Round 2), search (Round 2), favorites/home (#14, Round 2).
- VOD seek, pause/resume scrubbing, and audio/subtitle track pickers (#73, the immediately following `0.1` slice).

### Anti-Goals
- Never materialize an entire 25k–100k category array in JS memory.
- Never construct or retain a native `PlayerEngine` inside `useMemo` or leave a stream connection open when the app backgrounds or unmounts.
- Never fork components by `.tv.tsx` / `.web.tsx` filenames; use `useFormFactor()` only.

## 3. Approaches Considered

### 3.1 Large Category Lists Across Form Factors
1. **Load all category items into a `FlatList` array:** Rejected — allocates tens of thousands of row objects on large sources and stalls JS.
2. **Chosen — Shared LRU-paged `ListSource<T>` + `ElvList<T>` (`TvList` on TV, `VirtualizedList` on touch/desktop):**
   - `@elv/ui-kit` already defines `ListSource<T>` (`count`, `get`, `prefetch`, `onChange`) for `TvList`.
   - Adding `ElvList<T>` in `@elv/ui-kit` renders `TvList` when `useFormFactor() === 'tv'` and React Native's `VirtualizedList` (`getItemCount`, `getItem`, `getItemLayout` with fixed `rowHeight`, `onViewableItemsChanged` -> `source.prefetch`) on `'phone'`, `'tablet'`, and `'desktop'` (plus ArrowUp/Down/PageUp/PageDown/Enter keyboard handling on `'desktop'`). Memory stays `O(window)` at 100k items on every platform.

### 3.2 Engine Lifecycle and Platform Surface Abstraction
1. **Duplicate `PlayerScreen` separately in `apps/tv-mobile` and `apps/desktop/renderer`:** Rejected — duplicates state, lifecycle, zapping, error copy, and background-stop logic.
2. **Chosen — Shared `PlayerScreen` in `@elv/features` over `VideoHost` + `AppLifecyclePort`:**
   - `VideoHost` (`openEngine(): PlayerEngine | null | Promise<PlayerEngine | null>`, `renderSurface(props): ReactElement`) lets `apps/tv-mobile` supply `Media3Surface` (Android) or `AetherSurface` (Apple) and `apps/desktop/renderer` supply `DesktopEngine` + `PlayerView` without `@elv/features` importing any native module or Electron API.
   - `AppLifecyclePort` (`subscribe(listener: (state: 'active' | 'background') => void): () => void`) wraps `AppState` on `tv-mobile` (and a no-op/window visibility adapter if needed), testable headlessly in Jest.

## 4. Detailed Design

### 4.1 `@elv/ui-kit` — `ElvList<T>` (`packages/ui-kit/src/list/ElvList.tsx`)
- Props: `listId`, `store` (used on `'tv'`), `source: ListSource<T>`, `rowHeight`, `visibleRows`, `selectedIndex`, `onSelectIndex(index: number)`, `onActivateIndex(index: number)`, `renderRow(item: T | undefined, active: boolean, index: number)`, `rowLabel(item: T | undefined, index: number)`, `testID`.
- On `'tv'`: delegates to `TvList`; pressing `OK` (`select` intent from `FocusStore`) invokes `onActivateIndex(currentIndex)`.
- On `'phone' | 'tablet' | 'desktop'`: renders `VirtualizedList` with `getItemLayout`, restores `initialScrollIndex` when remounting after `Back` from the player, highlights `selectedIndex`, activates on row press (or `Enter` on `'desktop'`), and calls `source.prefetch` around the visible window (`visibleStart - 20` .. `visibleEnd + 40`).

### 4.2 `@elv/features/src/browse/` — Paged Catalog Adapter & Browse State
- `createPagedListSource<T>({ count, pageSize = 200, maxPages = 16, loadPage }): ListSource<T> & { dispose(): void }`:
  - Maintains an insertion-ordered `Map<number, readonly T[]>` LRU page cache and an `inFlight = new Set<number>()` set.
  - `get(index)` computes `page = Math.floor(index / pageSize)`; on cache hit refreshes LRU order and returns `pageItems[index % pageSize]`; on cache miss returns `undefined`.
  - `prefetch(start, end)` schedules `loadPage(page * pageSize, pageSize)` for each missing page in `[start..end)`, evicting oldest pages past `maxPages` and firing `onChange` listeners when resolved (unless `disposed`).
- `BrowseView` (`kind: 'live' | 'movie' | 'series'`):
  - Aggregates categories across `listSources()` in source order; prefixes category names with `${source.name} — ` only when `sources.length > 1`.
  - Remembers per-tab `{ categoryId, itemIndex, seriesDetail?: { series: ItemRow; season: number; episodeIndex: number } }` inside the shell state so switching tabs or entering/exiting `PlayerScreen` preserves the exact position and focused index.
  - Two-column split (`Categories` | `Items`, or `Seasons` | `Episodes` inside Series Detail) on `'tv'`, `'tablet'`, and `'desktop'`; single-pane step-in with a plain `Back` header button on `'phone'`.
  - TV remote grammar (spec §5.6): `Left` from items focuses categories; `Right` or `OK` on a category focuses items; `Back` steps out (`Player -> Episodes -> Browse Items -> Categories -> Top Tabs`).

### 4.3 `@elv/features/src/player/` — `PlayerScreen`
- Opens `videoHost.open()` (`{ engine, renderSurface }`) inside `useEffect`; if unmounted before a Promise resolves, immediately calls `opened.engine.release()` on resolution. Constructs `createPlaybackService({ engine: opened.engine, clock, timers })` in the same effect and disposes both on unmount.
- Tunes `target` via `service.tune({ item: target.itemKey, accountKey: target.sourceId, kind: target.kind, resolve: () => catalog.resolveStream(target.itemKey) })`.
- Subscribes to `appLifecycle`:
  - On `'background'`: if currently active (`status.kind !== 'idle'`), records `resumeOnActive = true` and calls `service.stop()` so audio halts and the provider HTTP connection closes immediately.
  - On `'active'`: if `resumeOnActive` is `true`, clears the flag and re-tunes the current target.
- Live channel zapping: when `target.kind === 'live'` and `playlist` is present, `Up` / `ChannelUp` (`+1`) and `Down` / `ChannelDown` (`-1`) (plus plain `Prev` / `Next` buttons on touch/desktop) wrap within `[0, playlist.count)` using `playlist.getAt(nextIndex)` and update the shell's remembered `itemIndex` so pressing `Back` after zapping highlights the channel the user actually zapped to.
- Always-mounted OSD (`testID="player-osd"`): displays title, localized status + actionable playback error hint when `failed`, `OsdClock`, `Retry` button on failure (`player-retry`), and `Back` control (`player-back`).

### 4.4 `packages/features/src/AppShell.tsx` & App Composition Roots
- Root-level `packages/features/src/AppShell.tsx` (at `src/` root so `no-feature-to-feature` stays green across `browse/`, `player/`, and `sources/`) owns:
  - Active tab (`'live' | 'movie' | 'series' | 'sources'`), switching to `'sources'` initially only if `listSources()` is empty.
  - Startup background import of any source with `needsImport === true`.
  - Active `PlayTarget | null` and the live `PlaybackGuard` (`stopIfUsingSource(sourceId)` stops playback, clears `PlayTarget` if `playTarget.sourceId === sourceId`, and refreshes browse categories).
- `apps/tv-mobile/src/App.tsx` wires `createMedia3Engine` / `createAetherEngine`, `Media3Surface` / `AetherSurface`, `AppState`, `expo-localization`, and `createDeviceCatalog()`.
- `apps/desktop/renderer/src/App.tsx` wires `createDesktopEngine`, `PlayerView`, `navigator.languages`, and `createDesktopCatalog()`.

## 5. Testing Strategy
- `@elv/i18n` (Vitest): EN/TR parity for all new browse, series, and player strings.
- `@elv/ui-kit` (Jest): `ElvList` rendering, paging prefetch, selection, and position restoration across `'tv'`, `'phone'`, `'tablet'`, and `'desktop'`.
- `@elv/features` (Vitest `>= 90%` coverage on `paged-list-source.ts` + browse/player state helpers; Jest RNTL on `AppShell`, `BrowseView`, and `PlayerScreen`):
  - 25,000-channel category test proving `createPagedListSource` + `ElvList` loads only visible pages (`<= 2` SQLite `items()` calls on initial render and jump-to-middle) with zero full-array materialization.
  - Series drilldown test against simulator Xtream `demo` account (`seasons` -> `loadSeriesEpisodes` -> `episodes` -> play episode -> `Back` restores exact episode focus).
  - `PlayerScreen` lifecycle tests proving: (a) engine is created in an effect and released on unmount (including async `openEngine` unmount race), (b) `'background'` stops the engine and `'active'` re-tunes, (c) live channel zapping updates the focused index restored on `Back`, and (d) removing the active stream's source in `Sources` stops playback immediately.
  - Multi-form-factor tests (`'tv'`, `'phone'`, `'tablet'`, `'desktop'`) verifying D-pad, touch, mouse, keyboard, and stable semantic `testID`s.

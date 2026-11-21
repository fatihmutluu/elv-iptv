# Zero-Blink Instant Prewarm, Artwork Hardening & Write Coalescing Design

- Date: 2026-11-22
- Issues: `#445`, `#202`, `#311`, `#230`
- Scope: `@elv/domain`, `@elv/data`, `@elv/ui-kit`, `@elv/features`, `apps/tv-mobile`, `apps/desktop`, `docs/design/UI_UX_PHILOSOPHY.md`

## 1. Problem Statement
1. **Visible 1-frame blinks & empty flashes (`#445`):** Switching top-level tabs (`Home`, `Live`, `Movies`, `Series`), changing categories, returning from `DetailScreen` / `PlayerScreen`, or switching seasons on `DetailScreen` currently unmounts screen hooks or resets state to loading skeletons (`useHomeData`, `useCatalogDiscovery`, `useCategoryGridData`, `useLiveCatalog`, `useLiveFavorites`, `useDetailData`). Even fast local SQLite reads flash blank category bars, empty headers, or `<EpisodeSkeletonRows />`.
2. **Coarse dead-host circuit breaking (`#202`):** `DeadHostRegistry` treats all image load errors identically (3 failures blacklist an entire CDN host permanently for the session with no TTL, no DNS-vs-404 distinction, and no reconnect reset).
3. **Unwired decode caps (`#311`):** `ArtworkImage` accepts `maxDecodePx`, but `UiAdaptersProvider` is not mounted in `apps/tv-mobile` or `apps/desktop`, and the RN `<Image>` fallback omits Android `resizeMethod="resize"`, `fadeDuration={0}`, and intrinsic decode hints.
4. **Uncoalesced rapid remote writes & hard tvOS list edges (`#230`):** Rapid remote toggles on favorites, watched state, and preferences trigger immediate sequential storage writes, and tvOS vertical list viewports clip scrolling rows abruptly at viewport edges.

## 2. Architecture & Contracts

### 2.1 Zero-Blink `CatalogUiCache` & Prewarm (`#445`, `@elv/features`)
- **Scoped instance (`CatalogUiCache` + `CatalogUiCacheProvider`):** Created inside `AppShell` per `catalog` instance (never a leaking process singleton). Keyed by monotonic `catalogRevision` (bumped strictly on source add/remove/import completion) and `locale`.
- **Bounded memory slices (safe on 1 GB TV sticks):**
  - `home`: cached `HomeSnapshot` + `heroIndex`.
  - `catalogByKind` (`movie`, `series`): cached `categories`, `continueItems`, bounded `railItemsByCategoryId` (max 16 categories × 18 items), `progressByKey`, and LRU `gridFirstPageByCategoryId` (max 12 categories).
  - `live`: cached `categories`, LRU `firstChannelsByCategoryId` (max 8 categories × 120 rows), `favoriteKeys` + `favoriteChannels`, plus persistent bounded TTL LRU caches for `nowNext` and `epgWindow` that survive tab and sub-mode switches.
  - `detailByItemKey`: bounded LRU (max 32 entries) storing `DetailSnapshot` + `episodesBySeason: Map<number, readonly EpisodeRow[]>` + `episodeProgressByKey`.
  - `search`: last `{ query, scope, catalogRevision, results, progressByKey }`.
- **Startup & Post-Import Background Prewarm:** Once `listSources()` resolves with `sources.length > 0` (and on `catalogRevision` bump), non-blocking cancellable prewarm warms `Home`, `Live` categories + first slice + favorites, and `Movie`/`Series` categories + top rails.
- **Startup Tab Anti-Flash:** `AppShell` tracks `sourcesResolved` so initial mount does not flash `Settings -> Sources` for 1 frame before jumping to `Home` when sources already exist.
- **Zero-Blink Season Switching & Player Return (`useDetailData` + `DetailEpisodes`):**
  - Returning from `PlayerScreen` (`userStateVersion` bump) NEVER resets `seasonsState` to `'loading'` or wipes `episodes`; it silently refreshes watch progress and favorites in place.
  - Once a series's seasons load, adjacent seasons (or up to 4 additional seasons) prewarm quietly into `episodesBySeason`.
  - `selectSeason(season)` serves cached episodes synchronously on frame 0 (`episodesLoading = false`). For an uncached season, `keepPreviousData` keeps existing episodes rendered softly (`episodesRefreshing = true`) until the new season resolves — zero `<EpisodeSkeletonRows />` flash on switch.
- **Stale-While-Revalidate on Refresh:** `useCatalogDiscovery`, `useHomeData`, `useLiveCatalog`, `useCategoryGridData`, and `useDetailData` hydrate synchronously from `CatalogUiCache` on mount and keep previous data visible during background revalidation; stale cache entries clear cleanly when `catalogRevision` advances or a source is removed.

### 2.2 Write Coalescing (`#230` Part A, `@elv/domain` + `@elv/data` + `apps/*`)
- **`setFavorite(db, input, active, clock)`** in `packages/data/src/user-state.ts` + optional `CatalogService.setFavorite`: idempotent desired-state favorite write (eliminating flip-flop parity hazards under rapid remote toggles). Desktop catalog IPC (`catalog-ipc.ts`, `catalog-worker-runtime.ts`, `desktop-catalog.ts`) forwards `setFavorite`.
- **`createWriteCoalescer({ windowMs = 500, setTimeoutFn, clearTimeoutFn })`** in `packages/data/src/write-coalescer.ts`: deduplicates pending writes per composite key within the 500 ms window, keeping only the latest desired state, and provides deterministic concurrent-safe `flush()` and `dispose()`.
- **`createCoalescedCatalog(catalog, { windowMs = 500 })`** in `packages/data/src/write-coalescer.ts`: wraps `CatalogService` so rapid `setFavorite`, `setWatched`, and `saveProgress` bursts coalesce per `(profileId, itemKey)` while `flush()` immediately commits all pending writes. `AppShell` wraps its catalog with `createCoalescedCatalog` and calls `flush()` on `appLifecycle` `'background'`, desktop `beforeunload`, and unmount.
- **`useDetailData` rapid toggle fix:** Replaces `myListPendingRef` / `watchedPendingRef` press-dropping with optimistic generation-tracked updates calling `setFavorite` / `setWatched` through the coalesced catalog.
- **`createKvPreferencesStore(backend, key, opts?: { coalesceMs?: number })`** in `packages/domain/src/preferences.ts`: adds optional 500 ms write coalescing (`0` default for backwards compatibility; `500` in device and desktop stores) plus `flush(): Promise<void>` on `PreferencesStore`, flushed on background/unmount.

### 2.3 Dead-DNS Short-Circuit & Logo Decode Caps (`#202`, `#311`, `@elv/ui-kit` + `apps/*`)
- **`DeadHostRegistry` (`dead-host-registry.ts`):**
  - `classifyImageError(error?: { message?: string; statusCode?: number }): ImageErrorKind` (`'dns' | 'network' | 'http-4xx' | 'unknown'`).
  - Confirmed DNS/NXDOMAIN errors trip immediately (`dnsThreshold = 1`); network errors trip fast (`networkThreshold = 2`); single-object HTTP 404/4xx errors never blacklist the host; unknown errors use threshold `3`.
  - Bounded TTL (`ttlMs = 5 * 60_000`, injectable `now` clock) expires dead entries automatically; `reset()` clears state on network reconnect (`online` event on desktop/web; `AppState` `'active'` recovery on mobile/TV).
- **Real Decode Caps (`#311`):**
  - `ArtworkImage` fallback `<Image>` applies Android `resizeMethod="resize"`, `fadeDuration={0}`, bounded `{ width: maxDecodePx, height: maxDecodePx }` native hints, web `decoding="async"`, and extracts native `onError` details.
  - `apps/tv-mobile/src/ui/platform-adapters.tsx` and `apps/desktop/renderer/src/ui/desktop-adapters.tsx` wire `UiAdaptersProvider` into both app roots so `maxDecodePx` and error classification are live in production.

### 2.4 tvOS Scroll-Edge Fade Mask (`#230` Part B, `@elv/ui-kit` + `@elv/features`)
- **`TvScrollEdgeFade` (`packages/ui-kit/src/tv/TvScrollEdgeFade.tsx`):** Theme-derived (`theme.colors.bgCanvas`) eased top/bottom edge fade overlays using `Scrim` (and `adapters.renderGradient` when available), active automatically on tvOS (`Platform.OS === 'ios' && Platform.isTV`) or via explicit `enabled` prop.
- **`TvList` integration:** Renders top fade only when `windowStart > 0` and bottom fade only when `windowStart + visibleRows < count`, strictly **behind `FocusRing`** so edge-focused rows stay 100% sharp and legible. Applied to TV list viewports (`TvList`, `CategoryGridView`, `LiveChannelsGrid`, `EpgGridView`, `LiveZapDrawer`).

## 3. Verification Plan
- Pure-TS TDD tests (`>= 90%` line coverage): `write-coalescer.test.ts`, `user-state.test.ts`, `preferences.test.ts`, `dead-host-registry.test.ts`, `catalog-ui-cache.test.ts`.
- RNTL component/hook tests: `ArtworkImage.test.tsx`, `TvList.test.tsx`, `TvScrollEdgeFade.test.tsx`, `AppShell.test.tsx`, `HomeScreen.test.tsx`, `CatalogDiscoveryScreen` / `DetailScreen.test.tsx` (proving frame-0 warm tab render, zero-blink season switching, player-return preservation, and background flush), plus desktop IPC tests.
- Full `pnpm check` (`11 passed, 0 failed`), independent `Gemini 4 Neon (High)` whole-branch code review, and all GitHub CI checks green before squash-merge.

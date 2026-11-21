# Round 2 Slice 3 — Cinema Quietude Movies & Series Discovery, Row-Virtualized Category Grids & 2-Column Detail Screen

**Date:** 2026-11-21  
**Status:** Approved for implementation (autonomous Round 2)  
**Design Contract:** [UI_UX_PHILOSOPHY.md](../../design/UI_UX_PHILOSOPHY.md) §1–§6

## 1. Goals & User Value
Deliver the full Cinema Quietude VOD discovery and title detail experience across **Android TV, Fire OS, Apple TV (tvOS), Android Phone/Tablet, iPhone/iPad, Windows, macOS, and Linux**:
1. **Movies & Series Discovery (`CatalogDiscoveryScreen`):** Replaces the plain two-pane text list on the `Movies` and `Series` tabs with category & watch-status filter chips (`All`, `Unwatched`, `In progress`, `Watched`), horizontal `2:3` poster peek rails (`5.5` columns landscape / `3.5` columns portrait), and `See all ›` drill-down into an **O(1)-memory row-virtualized Category Grid** (`5` columns landscape / `3` columns portrait).
2. **2-Column Cinema Quietude Detail Screen (`DetailScreen`):** Unified full-bleed detail view for Movies and Series opened from Home, Catalog rails, Category grids, or *More Like This*:
   - Full-bleed hero backdrop (`maxDecodePx={960}`) + theme-derived `Scrim` + `Back` pill.
   - 2-column Hero bottom on Landscape (`230px` actions left: circular `+`/`✓` My List + Watched toggle + wide neutral-white `Play` / `Resume` / smart `Play Sx Ey` / `Resume Sx Ey` CTA; `1fr` rating/year/kind/synopsis right), stacking cleanly on Portrait.
   - Strict §3 section order: **Hero → Cast (when present, TMDB `#215` ready) → Season Selector & Episode List (Series) → More Like This**.
   - TV 10-ft initial focus lands directly on the primary Play/Resume CTA; pressing `Back` pops cleanly to the prior view without losing scroll or category selection.
3. **Indexed `itemDetail(itemKey)` Lookup (`@elv/data` + Electron IPC):** O(log N) lookup by `UNIQUE (source_id, key)` across `live`, `movies`, and `series` (zero table scan, zero SQLite migration) returning `ItemDetailRow` (`ItemRow` + `plot: string | null`) with play-time M3U logo resolution so opening any Movie or Series from Home (*My List* / *Continue Watching*) resolves its canonical id, synopsis, and artwork cleanly.

## 2. Zero-Jank Performance & Architecture Invariants
- **O(1)-Memory Category Grids:** Full category grids wrap `createPagedListSource<ItemRow>({ pageSize: 180, maxPages: 8 })` and render fixed-height rows (`VirtualizedList` with deterministic `getItemLayout` on pointer/touch; windowed `visibleRows + 2` rows driven by `@elv/focus-core` on TV). Never materialize full 10k–100k category arrays in JS memory.
- **Bounded Discovery Queries:** Initial discovery loads at most `8` categories (`LIMIT 18` items per rail, max `4` concurrent queries), expanding progressively on demand.
- **Zero-CLS Decode-Capped Artwork:** Posters cap decode at `320px`, episode stills at `320px`, Detail Hero backdrops at `960px`; unloaded slots render tonal `SkeletonBox` placeholders with exact target dimensions.
- **M3U Credential Isolation:** User-state writes (`saveProgress`, `toggleFavorite`) continue resolving raw catalog templates inside `@elv/data`; resolved M3U logo URLs never enter SQLite.
- **Dependency-Cruiser Hygiene:** Shared pure helpers (`createPagedListSource`, `DetailTarget`, `buildDisplayCategories`, `computeGridMetrics`) live in `packages/features/src/shared/` — zero feature-to-feature imports.
- **Strict Clean-Room & Accessibility:** Zero hardcoded hex colors (verified under default and `High Contrast (AAA)`), zero third-party brand names, 100% `@elv/i18n` EN/TR parity, `focusable={!isTv}` on all `@elv/focus-core`-managed TV screens.

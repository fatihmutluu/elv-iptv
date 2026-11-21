# Round 2 Slice 10 — Placeholder Live Channel Filter, TvList FocusStore Scroll Sync & 60+ Episode Season Chunking

## 1. Objective
Close two high-impact catalog and 10-ft TV ergonomics issues (`#152`, `#211`) across `@elv/data`, `@elv/ui-kit`, and `@elv/features`: eliminate provider offline placeholder channel bloat during M3U/Xtream import, guarantee deterministic `TvList` scroll sync when `FocusStore` restores focus across scopes, and chunk long 60+ episode seasons into O(30)-row sub-tabs on `DetailScreen`.

## 2. Deliverables & Contracts

### 2.1 Provider Placeholder Live Channel Filter (`#211`, `@elv/data`)
- **`packages/data/src/placeholder-filter.ts`:**
  - Pure `isPlaceholderLiveChannel({ name, streamId? }): boolean` using `foldText(name)`:
    - Rejects non-positive/invalid sentinel stream IDs (`streamId <= 0`, `NaN`, `'0'`, blank `streamId`), non-empty separator/symbol-only dividers (e.g., `---`, `***`, `### === ###`, `★★★`), and static offline event placeholders (after folding via `foldText`: `no event streaming`, `no event`, `no live event`, `no events`, `event not started`, `no stream available`, `offline placeholder`, `channel offline`). Preserves nameless playable streams (`name === ''`) when `streamId` is valid or absent for provider compatibility.
    - Strictly conservative: never rejects legitimate channel names containing words like `"Event Cinema"` or `"Live Sports 1"`.
- **`SourceSettings.includePlaceholderChannels?: boolean` (`packages/data/src/sources.ts`):**
  - Defaults to `false` (filter active); setting `true` preserves raw provider rows.
- **`import-xtream.ts` & `import-m3u.ts`:**
  - Filter placeholder live items BEFORE writing rows or `placements` so SQLite `live`, `live_fts` search, and grouped category `itemCount` all exclude dead placeholders. Record `c.counts.skippedPlaceholders` when `> 0`.

### 2.2 `TvList` Scroll-to-Index Sync on `FocusStore` Restore (`#152`, `@elv/ui-kit`)
- **`packages/ui-kit/src/tv/TvList.tsx`:**
  - Track `wasActive` in `synced.current`: whenever `isActive` transitions `false -> true` (e.g. `FocusStore.activate(listId)` or `FocusStore.popScope()` restoring focus to an index outside the previously rendered window), immediately cancel any in-flight `Animated.timing` and snap `offset.current.setValue(translate)` to the restored `windowStart`, ensuring the restored focused row and `FocusRing` are synchronously inside the viewport on the first frame.
  - Ensure `source.prefetch(prefetchStart, prefetchEnd)` covers the restored window immediately.

### 2.3 60+ Episode Season 30-Episode Chunking (`#152`, `@elv/features`)
- **`packages/features/src/detail/detail-model.ts`:**
  - Export `EPISODE_CHUNK_THRESHOLD = 60`, `EPISODE_CHUNK_SIZE = 30`, `EpisodeChunk` (`{ index, startIndex, endIndex, label }`), `buildEpisodeChunks(episodes, chunkSize?, threshold?)`, and `resolveInitialEpisodeChunkIndex(episodes, progressByKey, chunks)`.
  - Seasons with `< 60` episodes return `[]` (zero extra UI chrome). Seasons with `>= 60` episodes partition into 30-episode sub-tabs (`1–30`, `31–60`, `61–90`, ...) and auto-select the chunk containing the primary/resume episode!
  - Extend `DetailNavRowId` with `'episode-chunks'` (included by `buildDetailNavRows` only when `episodeChunksCount > 0`), keeping all existing `< 60`-episode TV navigation order unchanged.
- **`packages/features/src/detail/DetailEpisodes.tsx` & `DetailScreen.tsx`:**
  - Render horizontal `FilterChip` sub-tabs (`testID="detail-episode-chunks-bar"`, `testID="detail-episode-chunk-${chunk.index}"`) right under the Season Selector when `chunks.length > 0`, mounting ONLY the active chunk's `<= 30` `DetailEpisodeRow` items (preserving original full-season episode index for `onPressEpisode` & `nextEpisodes`!).
  - Full 10-ft TV D-pad navigation across `Seasons -> Episode Chunks -> Episodes -> More Like This`, auto-scrolling focused chunk chips into view.

## 3. Verification Plan
- Strict TDD across `@elv/data`, `@elv/ui-kit`, and `@elv/features`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2/2` green), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

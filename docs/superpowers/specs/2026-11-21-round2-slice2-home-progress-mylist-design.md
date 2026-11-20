# Round 2 Slice 2 — Watch Progress (`#14`), My List & Flagship Cinema Quietude Home

## 1. Goal & Scope
Deliver the Cinema Quietude **Home** experience (`docs/design/UI_UX_PHILOSOPHY.md` §1–§4) backed by real on-device SQLite persistence for **Watch Progress & Resume (`#14`)** and **My List (Favorites)**, plus the canonical **4-destination top navigation** (`Home`, `Live`, `Movies`, `Series` + `Settings`), engineered for zero UI-thread stalls and smooth low-RAM artwork rendering across TV, mobile, tablet, and desktop.

## 2. Data Layer & IPC (`@elv/data`, Electron `utilityProcess`, Mobile `op-sqlite`)
- **Schema Migration v2 (`SCHEMA_VERSION = 2`):**
  - `watch_progress` (`profile_id TEXT NOT NULL DEFAULT 'default'`, `source_id`, `item_key`, `kind`, `title`, `subtitle`, `logo`, `series_key`, `season`, `episode`, `position_ms`, `duration_ms`, `watched`, `updated_at`) with covering recent index `(profile_id, watched, updated_at DESC)` and `(source_id)`.
  - `favorites` (`profile_id TEXT NOT NULL DEFAULT 'default'`, `source_id`, `item_key`, `kind`, `title`, `logo`, `year`, `rating`, `added_at`) with recent index `(profile_id, added_at DESC)` and `(source_id)`.
  - Both tables registered in `EXPECTED_TABLE_COLUMNS` and `TABLES_BY_SOURCE` so source deletion atomically removes associated progress and favorites.
- **Watch Progress Rules (`#14`):**
  - Completion threshold: `positionMs / durationMs >= 0.90` marks `watched = true`; manual `setWatched(itemKey, watched)` override supported.
  - Minimum resume threshold: `>= 10_000 ms` prevents accidental short clicks from polluting Continue Watching.
  - Smart resume rewind: reopening an in-progress item starts `5_000 ms` earlier (`Math.max(0, positionMs - 5_000)`) for immediate viewer context.
  - Throttled persistence: `PlayerScreen` quantizes SQLite writes to `>= 10_000 ms` intervals during active playback and flushes immediately on `pause`, `seek`, `ended`, `background`, and unmount/target change, strictly keyed by captured `itemKey`.

## 3. Flagship Cinema Quietude Home & 4-Destination Navigation
- **Zero-Jank Loading & Artwork Discipline:**
  - Bounded parallel rail queries (`LIMIT <= 18` per rail, never scanning full categories).
  - Locked-aspect tonal `SkeletonBox` placeholders while loading (zero layout shift).
  - Every image routed through `ArtworkImage` with `maxDecodePx` (`960` Hero, `480` WideCard, `320` PosterCard) and dead-host circuit breaking, structured for clean future TMDB metadata enrichment (`#215`).
- **Home Composition (`UI_UX_PHILOSOPHY.md` §2.1 & §3):**
  - Transparent-to-frosted `overlay` `AdaptiveNavShell` (`Home`, `Live`, `Movies`, `Series` + `Settings`) floating cleanly over a full-bleed **Hero Spotlight carousel** (up to 5 featured items with `Play`/`Resume` CTA, live `+`/`✓` My List toggle, watched indicator, and dots).
  - **Continue Watching** (`16:9` `WideCard` rail with progress bars, play badges, remaining time, smart resume).
  - **On Air Now** (`16:9` `WideCard` rail with `LIVE` pills, instant live playback + playlist zapping, and `Channels ›` shortcut).
  - **My List** (`2:3` `PosterCard` rail synced live with `+`/`✓` toggles).
  - **Featured Movies** & **Featured Series** (`2:3` `PosterCard` rails with watch progress overlays and `See all ›` shortcuts).
  - Full 10-foot TV D-pad 2D rail focus navigation via `@elv/focus-core` with `focusable={!isTv}` on child primitives and smooth vertical/horizontal auto-scrolling.

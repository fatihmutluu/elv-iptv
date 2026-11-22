# Screens Polish, Artwork Cache, Errors, Progress, Settings & Live Ergonomics (`#405`, `#63`, `#65`, `#125`, `#126`, `#399`, `#398`, `#401`, `#145`)

**Date:** 2026-11-22  
**Status:** Approved for implementation  
**Scope:** `@elv/domain`, `@elv/i18n`, `@elv/data`, `@elv/ui-kit`, `@elv/features`, `apps/desktop`, `apps/tv-mobile`

---

## 1. Goals

Polish every core browsing, detail, live-TV, source-management, and settings screen to **Cinema Quietude v2** flagship quality (`docs/design/UI_UX_PHILOSOPHY.md`) with zero flicker, zero raw error jargon, real import progress, and complete settings organization:

1. **Bounded Artwork Disk Cache & Ambient Placeholders (`#405`):**
   - Pure LRU byte-budgeted cache index (`ArtworkCacheIndex`) enforcing configurable `64–256 MiB` limits with one-click clear from Settings.
   - Real on-device file-backed cache implementations for Electron desktop (`userData/artwork-cache/`) and Expo mobile/TV (`expo-file-system` cache directory), respecting `maxDecodePx` and `deadHosts` without leaking file handles.
   - Smooth ambient placeholders in `ArtworkImage` fading gently into loaded artwork (`reduceMotion`-safe, zero layout shift, zero flicker on revisited URIs via bounded in-memory loaded-URI cache).
2. **Clear Localized Source & Playback Errors (`#63`):**
   - Every `ElvError` category reaching UI maps to concise EN/TR copy naming the cause (including numeric HTTP status when present, e.g. `HTTP 403`, `HTTP 404`, `HTTP 429`, `HTTP 503`) and an actionable next step.
   - Never expose raw JS/native class names (`TypeError`, `AbortError`, `SQLITE_ERROR`), stack traces, URLs, or credentials.
3. **Real Monotonic Import Progress & Cancel (`#65`):**
   - Emit monotonic `percent` (`0–100`) alongside phase and counts from `@elv/data` (`import-progress.ts`, Xtream, M3U, XMLTV guide).
   - Replace the static `45%` fallback in `SavedSourcesPanel` with live moving percentage & counts (`tabular-nums`) and working `Cancel` keeping the previous catalog intact.
4. **Continue Watching Grouping, Watched Cleanup & `sort_title` (`#125`):**
   - Add SQLite schema v8 migration (`schema-v8.ts`) adding indexed `sort_title` on `items` and `series` populated via `sortTitleKey(name)` (stripping leading articles `"The"`, `"A"`, `"An"` for clean alphabetical sorting).
   - Keep Continue Watching deduplicated per `series_key` and exclude fully watched items from "Recently Added" / discovery rails via `excludeWatched` query filtering.
5. **Channel-Logo Readability & Multi-Source Badges (`#126`):**
   - Support `logoBackdropMode: 'plate' | 'invert' | 'off'` on `ArtworkImage` so dark transparent PNG logos stay crisp on OLED canvases across themes.
   - Show subtle deterministic per-source color pills on Live channel tiles and EPG rows when multiple sources are configured and `showSourceBadges` is enabled.
6. **Home Hero Crossfade, Reduced-Motion Auto-Rotation & Details CTA (`#399`):**
   - Support up to 5 featured slides with smooth opacity crossfade transitions (`reduceMotion`-safe).
   - Auto-rotate every `7 500 ms` strictly when `!reduceMotion && routeActive && !hovered && !tvFocused && slides.length > 1`.
   - Add a clear secondary `Details` CTA beside `Play` opening `DetailScreen` with full keyboard/D-pad support.
7. **Detail Screen Technical Badges, Pre-Play Track Selectors, Expandable Synopsis & Clickable Cast (`#398`):**
   - Render Cinema Quietude technical `MicroPill` badges from typed metadata with zero layout shift when absent.
   - Add compact pre-play Audio & Subtitle preference selectors passing selections into the launched playback target/session.
   - Add expandable `"Read more"` / full synopsis modal reader preserving TV focus traversal.
   - Make `DetailCastStrip` entries & director credits interactive (`onSearchPerson`) while strictly preserving **Hero → Cast → Seasons & Episodes → More Like This**.
8. **Dedicated `Playback` and `Live TV & Guide` Settings Panels (`#401`):**
   - Expand Settings sections cleanly to `Appearance`, `Playback`, `Live TV & Guide`, `Sources`, and `About & Licenses` with generalized 10-foot TV D-pad focus navigation (`useTvSettingsNavigation`) across all preference panels.
   - Persist all preferences safely within `@elv/domain`'s 4 KB `PreferencesSnapshot` ceiling.
9. **Two-Step OK Preview-Then-Fullscreen & Optional Channel-Name Cleanup (`#145`):**
   - Support optional `liveOkTwoStepPreview` mode: first OK/tap previews the channel inline (releasing any previous preview cleanly for `max_connections=1`), second OK/tap opens fullscreen `PlayerScreen`.
   - Support optional non-destructive `cleanChannelTitles` display formatting via `@elv/data`'s `cleanDisplayTitle` without mutating source keys or database rows.

---

## 2. Schema & Persistence Contracts

### 2.1 SQLite Schema v8 (`packages/data/src/schema-v8.ts`)
- `ALTER TABLE items ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';`
- `ALTER TABLE series ADD COLUMN sort_title TEXT NOT NULL DEFAULT '';`
- `CREATE INDEX IF NOT EXISTS idx_items_sort_title ON items(source_id, kind, sort_title, key);`
- `CREATE INDEX IF NOT EXISTS idx_series_sort_title ON series(source_id, sort_title, key);`
- Migration v8 backfills `sort_title` for existing rows using `sortTitleKey(name)`.
- `schema-expected.ts` updated to schema version `8`.

### 2.2 `@elv/domain` Preferences Additions (Verified `< 4 096` Bytes)
- `preferredAudioLang: string` (`''`)
- `preferredSubtitleLang: string` (`''`)
- `subtitleMode: 'auto' | 'always' | 'off'` (`'auto'`)
- `seekStepSec: 5 | 10 | 15 | 30` (`10`)
- `defaultResizeMode: 'fit' | 'fill' | 'stretch'` (`'fit'`)
- `epgTimeSpanHours: 2 | 3 | 6` (`3`)
- `epgGenreTints: boolean` (`true`)
- `epgShowClock: boolean` (`true`)
- `defaultLiveMode: 'favorites' | 'channels' | 'epg'` (`'favorites'`)
- `guideRefreshHours: 6 | 12 | 24` (`12`)
- `logoBackdropMode: 'plate' | 'invert' | 'off'` (`'plate'`)
- `showSourceBadges: boolean` (`true`)
- `liveOkTwoStepPreview: boolean` (`false`)
- `cleanChannelTitles: boolean` (`false`)
- `artworkCacheLimitMb: 64 | 128 | 256` (`128`)

---

## 3. Verification Plan
1. Strict TDD across `@elv/domain`, `@elv/data` (>= 90% coverage), `@elv/i18n`, `@elv/ui-kit`, `@elv/features`, `apps/desktop`, `apps/tv-mobile`.
2. `pnpm check` (`11 passed, 0 failed`).
3. Desktop Playwright E2E verification.
4. Independent `Gemini 4 Neon (High)` whole-branch code review (`VERDICT: PASS`).

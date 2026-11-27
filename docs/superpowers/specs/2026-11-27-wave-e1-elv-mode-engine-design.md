# Wave E1 Design Spec — ELV Mode Core Engine (IMDb-First Metadata Worker, Workers AI, Isolated Local DB & Multi-Source Merging)

> **Issue:** `#511` (ELV Mode Core Engine, umbrella `#459`)
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — zero performance penalty, zero RAM bloat, non-destructive enrichment, zero double poster fetches, zero hardcoded hex, zero RN `<Modal>` on TV, zero DVR/competitor copy)
> **Date:** 2026-11-27

## 1. Architectural Guarantees

1. **Zero Performance & RAM Penalty:** Raw IPTV catalog (`catalog.db`) stays untouched and non-destructive. All ELV enrichment data lives in a dedicated, isolated SQLite database (`elv-enrichment.db`) alongside `catalog.db`, queried via indexed lookups and cross-DB `ATTACH` joins (never loading 50,000-item JS arrays in memory; safe on 1 GB Fire TV devices). Turning ELV Mode off immediately restores raw provider data.
2. **IMDb-First + 100% Guaranteed Localized Synopses:**
   - All external metadata requests are isolated behind our Cloudflare Worker (`/v1/elv/*`, hosted in `apps/sync-server` with D1 migration `0003_wave_e1_elv_metadata.sql` and `[ai]` binding) with 30-day D1 + edge caching.
   - IMDb provides primary titles, ratings/votes, genres, posters (resized via CDN `._V1_QL75_UX300_.jpg`), 16:9 backdrops, cast/portraits, direct trailers, `More Like This` graphs, and daily trending/editorial feeds (`Top Picks`, `MOVIEmeter`, `TVmeter`, `Current & Upcoming TV Shows`).
   - Localized synopses (Turkish, English, and future locales) are permanently cached in D1 `elv_localized_synopses(imdb_id, lang)`. On cache miss for non-English locales, Cloudflare Workers AI translates the original IMDb synopsis once and caches it permanently (`1 ms`, `0` neurons for all subsequent users).
3. **3-Layer Zero-Wait Matching (No Provider Credentials on Wire):**
   - Layer 1 (`0 ms`): Xtream/M3U provider `imdb_id` / `tmdb_id` persisted in `catalog.db` (`schema-v24.ts`).
   - Layer 2 (Priority Viewport ~40 items -> Background 500-item batches): Sends strictly clean `{ key, cleanTitle, year, mediaType, providerImdbId?, providerTmdbId? }` (zero URLs/credentials) to `POST /v1/elv/match-batch`.
   - Layer 3 (Incremental): Collective D1 match cache + local `elv-enrichment.db` ensure subsequent refreshes only match newly added titles, while `manual_lock = 1` entries are never overwritten.
4. **Zero Double Poster Fetching:** When ELV Mode metadata enrichment is active and an item has a verified IMDb `poster_url`, catalog hydration substitutes the IMDb poster URI directly before `<ArtworkImage>` mounts, so IPTV's poster URL is never fetched. Unmatched items silently fall back to the IPTV poster.
5. **Multi-Source VOD/Series Merging & 7 Title Formats:**
   - Identical titles across localized/foreign names and across multiple IPTV sources merge by verified `imdb_id` (high-confidence matches only; ambiguous remakes are never merged).
   - 7 title display formats (`original` [default], `system`, `english`, `english_system`, `original_system`, `system_english`, `system_original`) with automatic elision when parenthetical and primary names fold identically. Search indexes original + English + localized aliases together.
   - Detail screen exposes a clean version/source selector displaying source name, verified actual resolution, and demoting fake-4K or repeatedly failing variants.
6. **Fake-4K / Broken-Variant Memory & Live TV ELV Mode:**
   - Actual playback `videoInfo` (`width`, `height`, `videoCodec`, `audioCodec`) is persisted in `elv_quality_memory` to flag fake-4K labels (`claimed 4K` with actual height `< 1800px`) and demote broken variants (`fail_count >= 2`).
   - Live TV ELV Mode enables provider-tag stripping, cross-category variant collapsing (`4K/FHD/HD/SD/HEVC/Backup`), healthy-first ordering + dead-channel demotion, automatic failover on drop, and cleaned-name EPG matching fallback.
7. **Settings -> ELV Mode:** Dedicated Settings section with master toggle + 8 independent feature toggles/dropdowns (`elvMergeVersions`, `elvEnrichMetadata`, `elvTitleFormat`, `elvCategorySource`, `elvSmartRecommendations`, `elvXrayEnabled`, `elvLiveEnhance`, `elvVerifyRealQuality`) and a top `previewSlot` seam ready for Wave E3's shared 4-card interactive preview.

## 2. Verification & Deployment
- Independent whole-branch **`Gemini 4 Neon (XHigh)`** review before merge.
- Full `pnpm check` (`11 passed, 0 failed`), CI green, squash-merge, then apply D1 migration `0003_wave_e1_elv_metadata.sql` and deploy updated Cloudflare Worker (with `[ai]` binding) live and verify `/health` + `/v1/elv/feeds` `200 OK`.

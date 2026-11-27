# Wave E2 Design Spec — ELV Mode Discovery, 3-Pool Recommendations, Rich Detail, Trailers, Cast Pages, Franchise Strip, Fix Match & In-Player X-Ray

> **Issues:** `#512` (ELV Mode Discovery, Rich Detail, Trailers, Cast Pages, Franchise Strip, Fix Match, IMDb Genres & 3-Pool Recommendations), `#352` (In-Player X-Ray Cast & Episode Overlay), `#459` (ELV Mode Umbrella)
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — zero performance penalty, `< 10 ms` on-device recommendations, desktop HWND-safe docked X-Ray, zero RN `<Modal>` on TV, zero hardcoded hex, clean public copy)
> **Date:** 2026-11-27

## 1. Goals & Architecture

### 1.1 Two-Tier 3-Pool On-Device Recommendation Engine (`< 10 ms`)
- **Golden Rule:** Every recommended title MUST match at least one playable item in the user's active IPTV catalog (`catalog.db` intersection), strictly honoring active profile `excludedSourceIds` and Kids Mode / parental rating limits.
- **Automatic Exclusions:** Watched (`watched = 1`), disliked (`👎`), already in `My List` (`favorites`), and parental-blocked items are excluded from recommendations.
- **3 Candidate Pools:**
  1. **Pool A — IMDb `More Like This` Graph (`mlt_imdb_ids_json`):** Collects neighbors of user's liked (`+6`), favorited (`+4`), watched (`+2`), and disliked (`-6`) titles; shared neighbors accumulate score.
  2. **Pool B — Local Enriched Top-Rated Library:** Queries top ~150 enriched matched items in `elv-enrichment.db` scored by genre affinity (`👍 +3`, `★ +2`, `watched +1.5`, `👎 -4`), cast/director affinity (`+2`), and Bayesian IMDb score.
  3. **Pool C — IMDb Daily Editorial/Trending Feeds (`top_picks`, `moviemeter`, `tvmeter`, `current_upcoming_tv`):** Refreshed from `/v1/elv/feeds` (6h TTL) and cached in `elv_feeds`, intersected with user's matched IPTV library so cold-start users with 0 likes immediately see relevant picks.
- **2 Weight Profiles:**
  - **Home Showcase (`profile: 'home'`):** Movies + Series mixed, `~65%` Trending/Top Picks/New (Pool C) + `~35%` Personal (Pool A + Pool B).
  - **`ELV Picks` Sub-Tab (`profile: 'elv_picks'`):** Per-kind Movies or Series, `~70%` Personal (Pool A + Pool B) + `~30%` Trending/Quality (Pool C).

### 1.2 IMDb Genres & `ELV Picks` Sub-Tab
- When `elvModeEnabled && elvCategorySource === 'imdb'`, Movies and Series category rails show localized IMDb genre tabs (`Action`, `Sci-Fi`, `Drama`, `Thriller`, `Comedy`, `Animation`, `Documentary`, etc.) derived strictly from matched playable items — no extra top-bar toggle chip (switched back to provider folders solely in `Settings -> ELV Mode`).
- `ELV Picks` sub-tab automatically appears in Movies & Series when `elvModeEnabled && elvSmartRecommendations`, refreshing reactively on `★ / 👍 / 👎 / watched` changes.

### 1.3 Rich Detail, Trailers, Clickable Cast/Director Pages, Franchise Strip & Fix Match
- **Rich Detail:** Lazily fetches `/v1/elv/title/:imdbId?lang=...` on Detail open (30-day cached in `elv-enrichment.db` -> 2nd open `0 ms`), displaying 16:9 IMDb backdrop, localized Workers AI synopsis, IMDb rating + vote count, runtime, year, clickable director, and clickable cast portraits + character names.
- **Trailer Action (`detail-trailer`):** Sits in `DetailHero`'s minimalist circular icon row above Play CTA. Prioritizes direct IMDb MP4/HLS stream in our own ad-free player (including tvOS); falls back to YouTube embed modal (Desktop/Mobile) or YouTube deep link (10-ft TV).
- **Franchise Strip (`DetailFranchiseStrip`):** Chronological rail of other movies/series in the same `franchise_key` available in the user's library.
- **Clickable Actor / Director Pages (`PersonLibraryModal`):** Shared in `packages/features/src/shared/` (respecting `no-feature-to-feature`) so both Detail and In-Player X-Ray open `"Also in your library"` for any cast member or director.
- **Fix Match (`DetailFixMatchModal`):** Detail overflow action searching `/v1/elv/search`, locking `manual_lock = 1` in `elv-enrichment.db` so refreshes never overwrite the correction.

### 1.4 In-Player X-Ray (`#352`)
- When `elvModeEnabled && elvXrayEnabled` on VOD playback, displays a quiet Cinema Quietude **X-Ray** strip on pause or OSD toggle (`player-xray-button`), showing episode metadata, director, and clickable cast portraits (opening `PersonLibraryModal`).
- **Desktop HWND safety:** Docked layout renders X-Ray in flex-flow cleanly outside the native HWND video pane; floating layout renders translucent glass overlay without obscuring center playback.

## 2. Verification
- Full `pnpm check` (`11 passed, 0 failed`), independent whole-branch `Gemini 4 Neon (High)` review, CI green across all platforms, squash-merge closing `#512`, `#352`, `#459`.

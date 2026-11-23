# Wave C3 — Sources, Import Ergonomics & Catalog Deduplication Design Spec

> **Issues:** `#51`, `#39`, `#182`, `#218`, `#404`
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2, zero storage permissions on mobile, zero hardcoded hex, zero DVR/competitor copy, zero URLs/credentials in SQLite)

---

## 1. Domain Preferences & Transport (`@elv/domain`)
- `TransportSettings` (`packages/domain/src/source.ts`): add optional `readonly allowLegacyTls?: boolean` (default `false`/omitted, opt-in per source `#182`).
- `HttpRequestOptions` (`packages/domain/src/http.ts`): add optional `readonly allowLegacyTls?: boolean`.
- `ExtendedPreferencesFields` & `DEFAULT_PREFERENCES`:
  - `collapseLiveVariants: boolean` (default `false`, `#218`)
  - `groupVodVersions: boolean` (default `true`, `#404`)

## 2. XMLTV DST Timezone, `<lcn>`, `<rating>` (`@elv/sources`, `#182`)
- `parseXmltvTime(text, opts?: { defaultTimeZone?: string })` & `XmltvOptions.defaultTimeZone?: string`:
  - Apply IANA DST-aware conversion ONLY when the XMLTV timestamp omits an explicit offset (`+HHMM`, `Z`, `UTC`, `GMT`).
  - Use cached `Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year/month/day/hour/minute/second })` with deterministic 2-pass offset resolution handling spring-forward gaps & fall-back overlaps. Ignore invalid timezones gracefully (fallback UTC).
- `XmltvChannel`: add optional `readonly lcn?: string` parsed from top-level `<lcn>` on `<channel>`.
- `XmltvProgramme`: add optional `readonly ratingSystem?: string` and `readonly ratingValue?: string` parsed from top-level `<rating system="..."><value>...</value></rating>` on `<programme>` (keeping `<icon>` stack isolation intact).

## 3. SQLite `MIGRATION_V11` & Data Layer (`@elv/data`, `#51`, `#39`, `#182`, `#218`, `#404`)
- `MIGRATION_V11` (`schema-v11.ts`, registered in `schema.ts`, `schema-expected.ts`, `migrate.ts` with idempotent backfill on existing rows):
  - `guide_channels`: `ALTER TABLE guide_channels ADD COLUMN lcn TEXT;`
  - `programmes` & `programmes_next`: `rating_system TEXT`, `rating_value TEXT`
  - `live` & `live_next`: `variant_base_fold TEXT NOT NULL DEFAULT ''`, `quality_rank INTEGER NOT NULL DEFAULT 0` + `CREATE INDEX IF NOT EXISTS idx_live_variant ON live (source_id, is_hidden, variant_base_fold, quality_rank DESC);`
  - `movies` & `movies_next`: `version_group_key TEXT NOT NULL DEFAULT ''`, `version_label TEXT` + `CREATE INDEX IF NOT EXISTS idx_movies_version_group ON movies (source_id, is_hidden, version_group_key);`
  - `watch_progress`: `version_group_key TEXT`, `preferred_item_key TEXT` + `CREATE INDEX IF NOT EXISTS idx_watch_progress_vgroup ON watch_progress (profile_id, version_group_key);`
- `SourceSettings` (`sources.ts`):
  - `xmltvTimezone?: string` (`#182`)
  - `categorySelection?: SourceCategorySelection` (`#39`):
    ```ts
    export interface SourceCategorySelection {
      readonly live?: readonly string[];
      readonly movie?: readonly string[];
      readonly series?: readonly string[];
      readonly knownLive?: readonly string[];
      readonly knownMovie?: readonly string[];
      readonly knownSeries?: readonly string[];
      readonly pendingLive?: readonly string[];
      readonly pendingMovie?: readonly string[];
      readonly pendingSeries?: readonly string[];
    }
    ```
  - `isLocalPlaylist?: boolean` (`#51`, marks local sandboxed M3U source so `openPlaylist` reads from `LocalPlaylistStore` keyed by `sourceId`, NEVER storing raw host filesystem paths in SQLite or `SecretStore`!)
- **New `CatalogService` methods (also wired through Electron `catalog-ipc` / `catalog-worker` / `desktop-catalog`):**
  ```ts
  export interface DiscoveredCategory {
    readonly id: string;
    readonly name: string;
    readonly kind: BrowseKind;
    readonly itemCount: number;
  }
  export interface LiveVariantOption {
    readonly key: string;
    readonly title: string;
    readonly qualityLabel: string;
    readonly qualityRank: number;
  }
  export interface VodVersionOption {
    readonly key: string;
    readonly title: string;
    readonly versionLabel: string;
    readonly year: number | null;
    readonly qualityRank: number;
  }
  // On CatalogService:
  addLocalM3uSource(input: { name: string; bytes: Uint8Array; guideUrl?: string }): Promise<SourceRow>;
  discoverSourceCategories(sourceId: string): Promise<readonly DiscoveredCategory[]>;
  liveVariants(itemKey: string, categoryId?: string): Promise<readonly LiveVariantOption[]>;
  itemVersions(itemKey: string): Promise<readonly VodVersionOption[]>;
  ```
- **Pure Deduplication Helpers:**
  - `packages/data/src/live-variants.ts` (`#218`): `parseLiveVariant(title)` -> `{ baseFold, qualityLabel, qualityRank }` (`4K`/`UHD`/`2160p`=40, `FHD`/`1080p`=30, `HD`/`720p`=20, `SD`/`480p`=10, `LOW`/`360p`=5, default=15). Strictly delimited token boundaries (never strips inside `4KIDS`, `HGTV`, and preserves `East`/`West`/`+1`/`+2`/`Backup`/language tags!). Collapses ONLY within `(source_id, category_id)`.
  - `packages/data/src/vod-versions.ts` (`#404`): `parseVodVersion(title, year)` -> `{ groupKey, versionLabel, qualityRank }`. Strips delimited quality/edition/language tags (`[4K]`, `(1080p)`, `HDR`, `HEVC`, `REMUX`, `WEB-DL`, `Dubbed`, `Subtitled`, `[TR]`), preserves years (`Movie (1990)` != `Movie (2024)`), preserves sequel numbers & Roman numerals (`2`, `3`, `II`, `III`, `Part 2`, `2001`, `1917`). Cross-variant watch progress syncs via `version_group_key`, remembers `preferred_item_key`, and deduplicates `listContinueWatching`.
- **Pre-import Category Filtering (`#39`):**
  - `discoverSourceCategories` streams Xtream categories/items or M3U `group-title`s in bounded memory without writing to SQLite.
  - `import-xtream.ts` & `import-m3u.ts` filter categories, items, and placements to the selected allowlist when `categorySelection[kind]` is defined; intentionally selected `0` categories skips `emptiedKinds` preservation so deselected kinds clear cleanly; subsequent refreshes compare discovered IDs against `known*`, recording newly appeared categories into `pending*` instead of importing silently!

## 4. Native Transport & Source Import Host (`#51`, `#182`)
- **Opt-in Legacy TLS (`#182`):**
  - Android (`StreamHttp.kt`): per-request `legacyTlsClient` with `ConnectionSpec.COMPATIBLE_TLS` + `CLEARTEXT` (default client remains `MODERN_TLS`).
  - Apple (`StreamHttp.swift`): per-request ephemeral `URLSession` with `tlsMinimumSupportedProtocolVersion = .TLSv10`.
  - Desktop (`apps/desktop`): per-request Node/undici legacy TLS `Agent` (`minVersion: 'TLSv1'`, `ciphers: 'DEFAULT:@SECLEVEL=0'`) scoped strictly to `allowLegacyTls === true` requests + `mpv` `LoadOptions.allowLegacyTls` handling.
- **Clipboard & Local File Picker (`#51`, ZERO storage permissions):**
  - `SourceImportHost` port in `packages/features/src/ports/source-import-host.ts`:
    `readClipboardText?: () => Promise<string | null>` and `pickPlaylistFile?: () => Promise<{ name: string; bytes: Uint8Array } | null>`.
  - Desktop (`apps/desktop`): `window.elv.sources.readClipboardText()` (Electron `clipboard.readText()`), `window.elv.sources.pickPlaylistFile()` (`dialog.showOpenDialog` with `.m3u`/`.m3u8`/`.gz` filter, bounded read <= 64 MiB), sandboxed `LocalPlaylistStore` under `userData/playlists/<sourceId>.m3u` deleted on `removeSource`.
  - Mobile (`apps/tv-mobile`): Android `ElvEngineMedia3Module` exposes `readClipboardText()` (`ClipboardManager`) & `pickPlaylistFile()` (SAF `ACTION_OPEN_DOCUMENT` — ZERO storage permission); Apple `ElvEngineAetherModule` exposes `#if os(iOS)` `UIPasteboard.general.string` & `UIDocumentPickerViewController` (`#if os(tvOS)` safely returns `nil`).
  - Web Workbench: `navigator.clipboard.readText()` fallback + `<input type="file" accept=".m3u,.m3u8,.gz">`.

## 5. UI Flows (`@elv/features`, Cinema Quietude v2)
- **`#51` SourcesScreen:** Compact `"Paste"` button next to M3U URL input (when `readClipboardText` available) + `"Choose file"` button for local M3U import (when `pickPlaylistFile` available), zero storage permissions requested.
- **`#39` Pre-Import Category Picker & Pending New Categories:** Optional `"Choose categories"` step before first import listing discovered categories with item counts per kind (`Live` / `Movies` / `Series`), select all/none/toggle, persisted per source; `SavedSourcesPanel` displays a quiet badge/action when `pending*` new categories appear on refresh (include or dismiss).
- **`#182` Source Advanced Transport:** Per-source XMLTV timezone selector/input (`IANA` e.g. `Europe/Istanbul`, `America/New_York`, `UTC`) and opt-in `"Allow legacy TLS"` toggle (off by default) inside the collapsible Advanced section of `SourcesScreen`.
- **`#218` Live Quality Variants:** `"Collapse live quality variants"` toggle in `Settings -> Live TV`; `LiveScreen` passes `collapseVariants` to queries; `PlayerScreen` / `PlayerSettingsSheet` exposes a `"Quality"` sub-view when `variants.length > 1` for single-connection-safe switching between `4K` / `FHD` / `HD` / `SD`.
- **`#404` Multi-Version VOD Grouping:** `"Group multi-version titles"` toggle in `Settings -> Playback`; Movies browse shows one clean card per group with subtle version count badge when `> 1`; `DetailScreen` fetches `itemVersions(itemKey)`, shows a clean Version selector pill alongside Audio/Subtitle pre-play controls (TV D-pad reachable), defaults to `preferred_item_key`, and shares watch progress across all versions.

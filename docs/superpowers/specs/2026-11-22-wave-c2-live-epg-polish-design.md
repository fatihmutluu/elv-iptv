# Wave C2 — Live TV & EPG Polish Design Spec

> **Issues:** `#68`, `#52`, `#53`, `#251`, `#395`, `#396`, `#400`
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — `Favorites | Channels | TV Guide`; zero Previous Channel / Number Pad clutter in `Favorites`; in-tree Cinema Quietude modals, zero RN `<Modal>` on TV; zero DVR/recording or third-party brand copy)

---

## 1. Domain Preferences (`@elv/domain`)
Add to `ExtendedPreferencesFields`, `DEFAULT_PREFERENCES`, and validators:
- `catalogRefreshHours: 0 | 6 | 12 | 24 | 48` (default `24`, `0` = manual only, `#68`)
- `guideRefreshHours: 0 | 6 | 12 | 24` (extend existing `6 | 12 | 24` to also accept `0` = manual only, default `12`, `#68`)
- `liveChannelSwitchMode: 'instant' | 'preview'` (default `'instant'`, `#251`)

## 2. XMLTV Category & Broadcast Flags (`@elv/sources`, `#396`)
- Extend `XmltvProgramme` (`xmltv-types.ts`) & `xmltv-children.ts` to parse top-level `<premiere>` into `isPremiere?: boolean` (alongside existing `categories`, `isLive`, `isNew`, `previouslyShown`).
- Export `EpgGenre = 'sports' | 'movie' | 'news' | 'kids' | 'series' | 'other'` and pure helpers in `packages/sources/src/epg-metadata.ts`:
  - `normalizeEpgGenre(categories: readonly string[]): EpgGenre | null` — case-insensitive multilingual (EN/TR/DE/FR/ES) category matching (`sports`/`spor`/`futbol`/`basketball`/`tennis`, `movie`/`film`/`sinema`/`cinema`, `news`/`haber`/`current affairs`, `kids`/`children`/`çocuk`/`animation`/`cartoon`, `series`/`drama`/`dizi`/`comedy`/`documentary`/`belgesel`, else `'other'` if non-empty categories present, else `null`).
  - `EPG_FLAG_LIVE = 1`, `EPG_FLAG_NEW = 2`, `EPG_FLAG_PREMIERE = 4`, `EPG_FLAG_REPEAT = 8` + `encodeProgrammeFlags(...)` / `decodeProgrammeFlags(mask)`.

## 3. SQLite `MIGRATION_V10` & Catalog API (`@elv/data` + Electron IPC, `#396`, `#53`, `#68`)
- `MIGRATION_V10` (`packages/data/src/schema-v10.ts`, wired into `schema.ts`, `schema-expected.ts`, `sources.ts`, `user-state-backup.ts`):
  - `ALTER TABLE programmes ADD COLUMN genre TEXT;`
  - `ALTER TABLE programmes ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;`
  - `ALTER TABLE programmes_next ADD COLUMN genre TEXT;`
  - `ALTER TABLE programmes_next ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;`
  - `CREATE TABLE recent_channels (profile_id TEXT NOT NULL DEFAULT 'default', source_id TEXT NOT NULL, item_key TEXT NOT NULL, watched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, item_key)) WITHOUT ROWID;`
  - `CREATE INDEX idx_recent_channels_order ON recent_channels (profile_id, watched_at DESC);`
  - `CREATE INDEX idx_recent_channels_source ON recent_channels (source_id);`
  - `CREATE INDEX idx_import_runs_source_kind_status ON import_runs (source_id, kind, status, finished_at DESC);`
- Populate `genre` & `flags` at XMLTV import time in `guide-programmes.ts` / `guide-commit.ts`, and expose `genre?: EpgGenre | null` & `flags?: number` (or decoded `isLive`/`isNew`/`isPremiere`) on `ProgrammeRow` & `CrossChannelProgrammeRow` (`guide-queries.ts`, `guide-queries-slice.ts`).
- `packages/data/src/recent-channels-repo.ts`:
  - `recordRecentChannel(itemKey: string, sourceId: string, profileId?: string): Promise<void>` — parameterized UPSERT (`watched_at = now`), prunes oldest entries beyond top 50 per profile, rejects credentials/URLs.
  - `listRecentChannels(limit?: number, profileId?: string): Promise<readonly LiveEntry[]>` — `INNER JOIN live` filtering `is_hidden = 0`, default `limit = 20`, ordered `watched_at DESC, item_key ASC`.
  - Wire onto `CatalogService`, `finishDeletingSource` (`sources.ts`), `user-state-backup.ts`, and Electron `catalog-ipc` / `catalog-ipc-guards` / `catalog-bridge` / `catalog-worker-runtime` / `desktop-catalog` + Workbench `mock-catalog`.
- Expose `lastCatalogSyncAt: number | null` and `lastGuideSyncAt: number | null` on `SourceRow` (derived from `import_runs WHERE status = 'ok'`, O(1) via new index).

## 4. Feature & UI Flows (`@elv/features`)
- **`#68` Automatic Source & Guide Refresh (`useGuideAutoRefresh.ts`, `AppShell.tsx`, `SavedSourcesPanel.tsx`, `LiveTvSettingsPanel.tsx`):**
  - Check persisted `source.lastCatalogSyncAt` & `source.lastGuideSyncAt` immediately on startup (non-blocking), on 15m foreground interval, and on browser/app `online` reconnect.
  - Strictly pause/abort/defer when fullscreen `playTarget !== null` OR Live TV embedded background preview (`LiveWatchStage` / two-step preview) is playing (single-connection safety!). Per-source 1h failure backoff avoids retry loops when offline/5xx.
  - Add per-source manual `Refresh guide` button + last-synced timestamp in `SavedSourcesPanel`; expose `Catalog refresh interval` & `Guide refresh interval` (with `Manual only`) in `LiveTvSettingsPanel`.
- **`#52` Previous Channel (`usePlayerTargetHandoff.ts`, `AppShell.tsx`, `LiveScreen.tsx`, `LiveChannelsGrid.tsx`, `EpgGridView.tsx`):**
  - Snapshot `burstOriginTarget` before coalesced CH+/CH- bursts so `A -> [B, C] -> D` stores `A` as `previousChannel` (only updating on committed switch).
  - Keep `liveMemory` synchronized across `openPlayTarget`, `replacePlayTarget`, and `onPlayerExit`.
  - Wire 1-key `lastChannel` (`P` / `KEYCODE_LAST_CHANNEL`) + compact Previous Channel action inside `Channels` & `TV Guide` modes — explicitly OMITTED from `Favorites` stage (`UI_UX_PHILOSOPHY.md` §2.1).
- **`#53` Recently Watched Channels (`usePlayerTargetHandoff.ts` / `PlayerScreen.tsx`, `HomeScreen.tsx`, `PlayerChannelDrawer.tsx`):**
  - Call `catalog.recordRecentChannel` ONLY after tune commits/stabilizes (post-`ZAP_COALESCE_MS` / active playback — never rapid intermediate zaps).
  - Surface *Recently watched channels* (`16:9` wide rail, max 20 deduplicated) on `HomeScreen` when non-empty, AND add an `All | Recent` filter tab inside `PlayerChannelDrawer`.
- **`#251` Optional Browse-While-Watching (`NO_SWITCH`) OSD Preview (`zap-controller.ts`, `usePlayerTargetHandoff.ts`, `usePlayerControls.ts`, `PlayerOsdTopBar.tsx`, `DesktopCinemaBar.tsx`, `LiveTvSettingsPanel.tsx`):**
  - In `liveChannelSwitchMode === 'preview'`, `CH+`/`CH-` (and live Up/Down) cycles a separate `previewTarget` + queries its Now/Next WITHOUT mutating `activeTarget.itemKey` or interrupting video.
  - Displays preview channel title, Now/Next, and `"Press OK to tune"` indicator in the OSD; `OK`/`Select` tunes it; `Back` or OSD auto-hide cancels preview without exiting player.
- **`#395` & `#396` EPG Grid Polish (`EpgChannelRow.tsx`, `EpgGridView.tsx`, `EpgPreviewHeader.tsx`, `EpgProgrammeDetailModal.tsx`, `useEpgTimeCursor.ts`, `useEpgWindowData.ts`, `source-badge.ts`):**
  - Left-clipped `<` continuation indicator & pinned legible title when `slot.clippedStart === true` (safe on narrow cells).
  - Multi-day DST-safe date tabs (`Today` .. `+6d` via `new Date(y, m, d)` + `localDayKey`) above the 30-min ruler preserving `focusedRow` and TV focus traversal (`toolbar <-> dateTabs <-> grid`).
  - In-tree Cinema Quietude `EpgProgrammeDetailModal` (zero RN `<Modal>`) opened when selecting upcoming (`start > nowMs`) programmes (or via Context Menu `"Programme details"` for any programme), with `Tune channel`, `Add/Remove Favorite`, `Close`, TV key trap & focus restoration.
  - O(1) genre tint lookup from `ProgrammeRow.genre` (`source-badge.ts`, subtle theme-tokenized `3px` left border + low-alpha surface tint, AAA-safe) + compact `Live`, `New`, `Premiere` `MicroPill` badges on sufficiently wide cells, `EpgPreviewHeader`, and `EpgProgrammeDetailModal`.
- **`#400` Long-Press Context Menu (`LiveContextMenu.tsx`, `LiveChannelsGrid.tsx`, `EpgGridView.tsx`, `LiveZapDrawer.tsx`):**
  - Opens on TV `{ key: 'select', kind: 'long' }` and `{ key: 'menu', kind: 'press' }`, touch `onLongPress` (`delayLongPress={450}`), and desktop right-click `onContextMenu` (`preventDefault`) without firing primary Play.
  - In-tree Cinema Quietude action sheet (`Play`, `Add/Remove Favorite`, `Programme details`, optional `onHideChannel` extension slot) trapping TV keys via `useTvKeyInterceptor` and restoring exact originating row/cell focus on close.

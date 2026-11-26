# Wave P4 — Reorderable Live Favorites, Unified Home Live Rail, Customizable Home Layout, Catalog Filter Tabs, Universal Context Menus & Initial-Only Preferences Sync

Date: 2026-11-26
Status: Approved (autonomous execution)

## Scope
1. **Drag-to-Reorder Live Favorites (SQLite v20 + Desktop IPC + UI):**
   - `MIGRATION_V20` (`packages/data/src/schema-v20.ts`) adds `sort_order INTEGER NOT NULL DEFAULT 0` to `favorites` and updates `EXPECTED_TABLE_COLUMNS.favorites`.
   - `listFavorites` orders by `CASE WHEN sort_order > 0 THEN 0 ELSE 1 END, sort_order ASC, added_at DESC, item_key ASC` (or dense 1-based `sort_order` with newly added favorites receiving `MAX(sort_order)+1` or `0` fallback — specifically: assign `sort_order = COALESCE(MAX(sort_order), 0) + 1` on new inserts and order by `sort_order ASC, added_at DESC, item_key ASC` so existing rows with `sort_order = 0` preserve recent order until reordered, and once reordered `1..N` is exact!). Wait: if existing rows have `0` and a new row gets `1`, `0` sorts before `1` — even better: `MIGRATION_V20` backfills existing rows using `added_at` or `sort_order` stays dense `0..N-1` on reorder and `setFavorite` assigns `COALESCE((SELECT MIN(sort_order) FROM favorites WHERE profile_id = ?), 0) - 1` so newly favorited channels appear at top, OR assign `sort_order` `0, 1, 2...` via `reorderFavorites` and keep `ORDER BY sort_order ASC, added_at DESC, item_key ASC`! Wait: if existing rows all have `0`, then when `reorderFavorites([k1, k2, k3])` writes `1, 2, 3`, any untouched row has `0` — so `reorderFavorites` updates the full ordered slice (`1..N`) and any remaining rows after `N` (`N+1..`), and `setFavorite` appends new favorites at `MAX(sort_order) + 1` (or `1` if empty), while `MIGRATION_V20` leaves default `0` and `ORDER BY CASE WHEN sort_order > 0 THEN 0 ELSE 1 END, sort_order ASC, added_at DESC, item_key ASC` puts explicitly ordered items first in `1..N` order and legacy `0` rows after by `added_at DESC`! That's 100% deterministic and upgrade-safe.
   - Add `reorderFavorites(orderedItemKeys: readonly string[], profileId?: string): Promise<Result<void>>` on `user-state.ts`, `CatalogService`, `createProfileScopedCatalog`, Desktop `catalog-ipc.ts` / `catalog-ipc-guards.ts` / `catalog-worker-runtime.ts` / `catalog-bridge.ts` / `desktop-catalog.ts`.
   - Wire drag-to-reorder (pointer drag-and-drop on desktop/web with live drop indicator + keyboard/TV Move Up / Move Down actions in context menu & row buttons) inside `LiveZapDrawer` / `LiveWatchStage` when viewing Favorites.

2. **Unified 12-Card Home "Live TV" Rail & Customizable Home Layout in Settings:**
   - Add compact `homeLayout: readonly HomeLayoutSectionPref[]` (`{ id: 'continue' | 'live' | 'mylist' | 'movies' | 'series' | 'collections', visible: boolean }`) to `@elv/domain` `PreferencesSnapshot` (`preferences-validators.ts`, `preferences.ts`, within `MAX_PREFERENCES_BYTES = 4096`).
   - Merge Home's `recentChannels` + `live` into a single unified **`live` ("Live TV" / "Canlı Yayınlar")** rail capped at **12 cards**, filled in strict deduplicated priority order:
     1. Live Favorites in the user's custom `sort_order` order,
     2. Recently Watched live channels,
     3. Current On-Now live channels.
   - Render Home rails (and dynamic collection rails) strictly following `preferences.homeLayout` visibility and order.
   - Add **Home Screen Layout** editor in Settings -> Appearance (`HomeLayoutEditor.tsx`) with a miniature Cinema Quietude live wireframe preview, show/hide toggles, up/down reorder buttons (plus desktop drag reorder), and Reset Default button.

3. **Movies & Series Quick Filter Bar:**
   - Extend `CatalogFilterHeader` & `CatalogDiscoveryScreen` so right beside `Categories ▾`, Cinema Quietude borderless underline quick tabs appear: **`All (Tümü)` | `My List (Listem)` | `Watched (İzlenenler)`** (zero pill-bubble chips!), followed by category tabs.
   - Selecting `My List` filters to favorited items of that kind (`movie` or `series`); selecting `Watched` filters to watched items of that kind (with clean empty states if none).

4. **Universal Right-Click (Desktop) & Long-Press (Mobile/TV) `ContextMenu` Primitive:**
   - Add reusable `ContextMenu` + `ContextMenuHostProvider` (`useContextMenu`) to `@elv/ui-kit` mounted inside `ThemeProvider` alongside `TooltipHostProvider` (viewport edge-clamped, dark-glass Cinema Quietude tokens, Escape / backdrop click dismiss, TV D-pad Up/Down/Select/Back navigation).
   - Add optional `onContextMenu` / `onLongPress` props to `PosterCard` and `WideCard`.
   - Wire contextual actions across:
     - **Continue Watching cards** (Home & Movies/Series): Play/Resume, Go to Details, **Remove from Continue Watching ("Önermeyi Kapat")** calling `catalog.clearProgress(itemKey)`, Mark Watched.
     - **Live Channel cards** (Home Live rail, Live Channels, Live Favorites): Play, Open in Multi-View, Open in Popout (desktop), Add/Remove Favorite, Move Up / Move Down (in Favorites), Hide Channel.
     - **Movie & Series cards** (Home, Movies, Series, Search): Play, Go to Details, Add/Remove My List, Mark Watched / Unwatched.

5. **Initial-Only Preferences Sync on First Device Sign-In / Pairing:**
   - Add optional `initialPreferences?: Readonly<Record<string, unknown>>` (strictly allowlisted via `@elv/domain` `extractSyncablePreferences` / `sanitizeInitialPreferencesPatch` per Product Decision #40 — excluding hardware/device-local prefs!) to `VaultSnapshot` (`packages/sync/src/vault-merge.ts`, `vault-crypto.ts`).
   - Desktop (`apps/desktop/src/main/sync/sync-service.ts`, `sync-ipc.ts`, `preload/sync-bridge.ts`, `renderer/src/sync/desktop-sync-ports.ts`) & TV/Mobile (`apps/tv-mobile/src/sync/sync-runtime.ts`) attach the local syncable preference seed on snapshot push and apply remote `initialPreferences` **exactly once** on initial sign-in or QR pairing claim (persisted boolean guard per account/device), never continuously overwriting local preferences afterwards.

## Verification
- Strict TDD unit & component tests across `@elv/domain`, `@elv/data`, `@elv/sync`, `@elv/ui-kit`, `@elv/i18n`, `@elv/features`, `@elv/desktop`, `@elv/tv-mobile`.
- `pnpm.cmd check` passes `11 passed, 0 failed`.
- Independent `Gemini 4 Neon (High)` whole-branch code review before PR merge.

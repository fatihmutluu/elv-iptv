# Wave P6 — Unified Library Hub (`Kitaplık`), Like/Dislike Ratings (`👍/👎`), Star Unification (`★`), Grouped Series Downloads & `groupVodVersions` Default Off

Date: 2026-11-26
Status: Approved (owner decisions #49)

## Scope

### 1. Preferences Default (`@elv/domain`)
- Change `DEFAULT_PREFERENCES.groupVodVersions` from `true` to `false` (automatic multi-version VOD grouping reserved for ELV Mode; manual Settings toggle preserved).

### 2. Movie & Series Like/Dislike Ratings (`@elv/data`, `@elv/sync`, Desktop IPC, TV-Mobile Sync)
- **SQLite `MIGRATION_V23` (`packages/data/src/schema-v23.ts`):**
  - `ratings(profile_id, source_id, item_key, kind CHECK(kind IN ('movie', 'series')), value CHECK(value IN ('like', 'dislike')), title, logo, year, rating, updated_at, PRIMARY KEY (profile_id, item_key) WITHOUT ROWID)` + indexes `idx_ratings_profile_value`, `idx_ratings_source`.
  - Strictly Movies & Series ONLY (never Live TV). Cascade cleanup on `removeSource` and `deleteProfile`.
- **Repository & `CatalogService` (`packages/data/src/ratings-repo.ts`):**
  - `setRating(input, value: 'like' | 'dislike' | null)`, `getRating(itemKey, profileId?)`, `listRatings(opts?: { value?, limit?, profileId?, parentalUnlocked? })`, `listRatingMap(profileId?)`.
  - Forwarded through `createCoalescedCatalog`, `createProfileScopedCatalog`, `createObservedCatalog`, `createLazyCatalog`, and Desktop Catalog IPC.
- **E2EE Sync Vault (`@elv/sync`, Desktop & TV-Mobile snapshot bridges):**
  - Add backward-compatible optional `ratings?: readonly SyncRatingRecord[]` to `VaultSnapshot` (`VAULT_SCHEMA_VERSION = 1`), merged via LWW `mergeKeyedCollection`.
  - Export and apply ratings on both Desktop (`desktop-catalog-snapshot.ts`) and TV-Mobile (`catalog-snapshot.ts`).
- **Downloaded Series Total Episode Refresh:**
  - Extend `RefreshMyListNewEpisodesOptions` with optional `extraSeriesKeys?: readonly string[]` so `Library -> Downloads` keeps downloaded series' total episode counts (`X / Y`) fresh alongside My List series (provider-polite cooldown, never while streaming).

### 3. Unified Star Icon (`★`) & Like/Dislike UI (`@elv/ui-kit`, `@elv/features`)
- Add `'library'`, `'likeFilled'`, `'dislikeFilled'` icons to `packages/ui-kit/src/icons/paths.ts`.
- Unify all "Add to My List / Follow" buttons (`HomeHero.tsx`, `DetailHero.tsx`, `DesignGallery.tsx`, `PosterCard`, Live, Context Menus) to use `'star'` / `'starFilled'` (zero `'plus'` / `'check'` mismatch for My List!).
- Add **Like (`👍`)** and **Dislike (`👎`)** buttons for Movies & Series ONLY (never Live TV):
  - On `DetailHero` (next to `★` My List, fully reachable via 10-ft TV D-pad `heroActionSlots`),
  - Inside universal Right-Click (Desktop) / Long-Press (Mobile & TV) Context Menus across Home, Catalog, Search, and Library (keep poster hover clean with `★ / ▶ / ✓`).
- Disliked titles stay purely personal in `Library -> Likes -> Disliked` (do NOT hide from Home featured rails yet; reserved for ELV Mode).

### 4. Top Nav 5th Destination → `Library` (`Kitaplık`) Hub (`packages/features/src/library/`)
- Replace 5th top-nav destination `downloads` with **`library`** (`Library` / `Kitaplık`, icon `'library'`, testID `'nav-tab-library'`): `Home | Live TV | Movies | Series | Library` (+ `Search` & `Settings`).
- Build **`LibraryScreen`** with 4 Cinema Quietude borderless underline sub-tabs (identical grammar to Live TV's `Favorites | Channels | TV Guide`):
  1. **`Following` (`Takip Edilenler`):** Stacked horizontal rails with `See all ›` drill-down for **Live TV**, **Series**, **Movies**, plus **Collections**.
  2. **`Likes` (`Beğeniler`):** Horizontal rails with `See all ›` for **Liked** and **Disliked** Movies & Series.
  3. **`Watched` (`İzlenenler`):** Horizontal rails with `See all ›` for **Watched Movies** and **Watched Series**.
  4. **`Downloads` (`İndirilenler`):** Compact active downloads progress strip on top (when active downloads exist), followed by **Downloaded Movies** and **Grouped Downloaded Series** horizontal rails (one card per series displaying `X / Y episodes downloaded` with fresh total episode count + `NEW` indicator when new episodes arrived, drilling into that series' downloaded episodes!).
- Full 10-ft TV D-pad navigation, universal right-click/long-press Context Menus, and `UI_UX_PHILOSOPHY.md` update.

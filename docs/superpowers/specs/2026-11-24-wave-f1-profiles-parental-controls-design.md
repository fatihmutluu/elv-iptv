# Wave F1 — Local Profiles & Parental Controls (`#15`, `#31`)

**Date:** 2026-11-24
**Scope:** Local multi-profile management (`#15`) and PIN-protected parental controls (`#31`) across Android TV, Fire OS, Android phone/tablet, Apple TV (tvOS), iOS/iPadOS, and Desktop (Windows, macOS, Linux).
**Design Language:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) & Zero-Blink Prewarm (`Product Decision #38`).
**Note on `#26` (E2EE Sync):** Cross-device sign-in & cloud sync remain explicitly deferred pending product/hosting decisions; Wave F1 is 100% local, offline-first, and account-free while preserving sync-ready `profile_id` and `UserDataStore` seams.

---

## 1. Goals & Invariants

1. **Instant Local Profiles (`#15`):**
   - Users can create, rename, edit (avatar token & Kids flag), delete, and switch between local profiles on TV (10-ft D-pad), mobile/tablet (touch), and desktop (pointer/keyboard) without an account.
   - Each profile isolates its own `watch_progress`, `favorites`, `track_preferences`, `recent_channels`, `parental_settings`, `parental_locks`, and `PreferencesSnapshot` (`locale`, `themePreset`, `fontScale`, preferred languages, EPG density, etc.), while sharing imported IPTV sources and catalog tables cleanly.
   - A `'default'` profile always exists (seeded on migration v14) and deleting the last remaining profile is rejected (`storage/cannot-delete-last-profile`). Deleting a non-last profile purges all profile-scoped SQLite rows, removes its `SecretStore` PIN entry, deletes its preferences KV entry, and switches to the remaining default/first profile if it was active.
   - Profile IDs strictly match `/^[A-Za-z0-9._-]{1,64}$/` so every ID is safe across SQLite, `expo-secure-store`, Electron `worker-protocol.ts` (`SECRET_KEY_RE`), and `PreferencesKvBackend`.

2. **Query-Layer Parental Controls (`#31`):**
   - Per-profile parental policy (`enabled`, `blockAdultKeywords`, `maxRatingAge`, `unlockTimeoutMin`) persisted in SQLite (`parental_settings`).
   - PINs (4–8 ASCII digits) are **NEVER** stored in SQLite and **NEVER** emitted in logs, errors, or renderer storage. PINs are hashed with a 16-byte random salt using 10,000 iterations of pure-TS SHA-256 (`v1:<32-hex-salt>:<64-hex-digest>`), stored exclusively in `SecretStore` under `profile.<profileId>.pin` (Android Keystore / Apple Keychain / Electron `safeStorage`), verified with constant-time comparison, and rate-limited against brute-force attempts (5 consecutive wrong PINs trigger a 30-second lockout).
   - Category and item locks (`parental_locks`) are keyed by stable `(profile_id, source_id, target_kind, item_kind, target_key)` independently of `import_runs` and `*_next` staging tables so full M3U and Xtream refreshes **preserve 100% of locks**. Removing a source purges its `parental_locks` rows via `TABLES_BY_SOURCE`.
   - **Zero UI-Only Leakage:** Filtering is enforced directly in `@elv/data` SQL/service queries (`categories`, `items`, `itemsByCursor`, `allSourcesItems`, `allSourcesItemsByCursor`, `alphabetIndex`, `search`, `searchSuggestions`, `itemDetail`, `resolveStream`, `nowNext`, `epgWindow`, `crossChannelEpgSlice`, `channelByNumber`, `listContinueWatching`, `listFavorites`, `listRecentChannels`). Attempting `resolveStream` on a restricted item while locked returns `err(elvError('auth', 'parental-locked'))`.
   - **Zero Overhead Default Fast-Path:** When a profile has `enabled = 0` and zero locks, `@elv/data` executes the exact unburdened query path with zero extra joins or filters.
   - **Temporary Session Unlock:** Entering a valid PIN unlocks the active profile in memory for `unlockTimeoutMin` (15 / 30 / 60 min, or until restart/background/profile switch). Switching profiles or tapping "Lock now" immediately re-locks.

3. **Zero-Blink Switching & Cache Hygiene:**
   - Switching profiles or toggling parental unlock updates `CatalogUiCache` (revision key includes `activeProfileId` + `parentalUnlocked`), clears `BrowseFocusMemory`, `liveMemory`, `catalogMemoryByTab`, `detailStack`, and `recentSearches`, and stops active playback if the playing item is locked for the newly active profile.
   - Also repairs `packages/data/src/write-coalescer.ts` (`createCoalescedCatalog`) so `categories` and `items` forward `opts`, and every `CatalogService` method (including profiles, parental controls, `searchSuggestions`, `alphabetIndex`, `liveVariants`, `itemVersions`, `trackPreference`, `recentChannels`) is forwarded faithfully on both mobile/TV and desktop.

---

## 2. Schema & Data Layer (`@elv/data`, `MIGRATION_V14`, `SCHEMA_VERSION = 14`)

### 2.1 New Tables (`packages/data/src/schema-v14.ts`)

```sql
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_token TEXT NOT NULL DEFAULT 'crimson',
  is_kids INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

INSERT OR IGNORE INTO profiles (id, name, avatar_token, is_kids, is_default, created_at, updated_at)
VALUES ('default', 'Default', 'crimson', 0, 1, 0, 0);

CREATE TABLE IF NOT EXISTS parental_settings (
  profile_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  block_adult_keywords INTEGER NOT NULL DEFAULT 1,
  max_rating_age INTEGER,
  unlock_timeout_min INTEGER NOT NULL DEFAULT 30,
  updated_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS parental_locks (
  profile_id TEXT PRIMARY KEY_OMITTED -- see composite PK below
);
```
Exact `parental_locks` DDL:
```sql
CREATE TABLE IF NOT EXISTS parental_locks (
  profile_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, source_id, target_kind, item_kind, target_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_parental_locks_source ON parental_locks (source_id);
CREATE INDEX IF NOT EXISTS idx_parental_locks_profile ON parental_locks (profile_id, target_kind, item_kind);
```

- `EXPECTED_TABLE_COLUMNS` in `schema-expected.ts` includes `profiles`, `parental_settings`, and `parental_locks`.
- `TABLES_BY_SOURCE` in `sources.ts` includes `'parental_locks'` (cleaned atomically when a source is deleted, never touched by `import_runs`).
- `user-state-backup.ts` reads `profiles` into `UserDataSnapshot.profiles` on `saveUserDataSnapshot` and restores missing `profiles` rows on `reconcileUserData`.

### 2.2 Pure Modules (`packages/data/src/`)

- **`profiles-repo.ts`**:
  - `PROFILE_AVATAR_TOKENS = ['crimson', 'sapphire', 'amber', 'violet', 'emerald', 'slate'] as const`
  - `ProfileRecord`: `{ id, name, avatarToken, isKids, isDefault, createdAt, updatedAt }`
  - `listProfiles(db)` (ordered `is_default DESC, created_at ASC, id ASC`; auto-ensures `'default'` if empty)
  - `createProfile(db, input, clock, newId?)` (validates trimmed name 1..40 chars, generates `p_<base36>_<rand>` matching `PROFILE_ID_RE`, inserts row; if `isKids: true`, also seeds default `parental_settings` with `enabled: 1, blockAdultKeywords: 1, maxRatingAge: 12`)
  - `updateProfile(db, id, patch, clock)` (updates name, avatarToken, isKids)
  - `deleteProfile(db, secrets, id)` (blocks deleting last remaining profile with `storage/cannot-delete-last-profile`; deletes `profiles`, `watch_progress`, `favorites`, `track_preferences`, `recent_channels`, `parental_settings`, `parental_locks` in one transaction, then removes `profile.<id>.pin` from `SecretStore`)

- **`parental-policy.ts`**:
  - `ParentalSettings`: `{ profileId, enabled, blockAdultKeywords, maxRatingAge: number | null, unlockTimeoutMin: number, updatedAt: number }`
  - `ParentalLockRecord`: `{ profileId, sourceId, targetKind: 'category' | 'item', itemKind: 'live' | 'movie' | 'series', targetKey: string, createdAt: number }`
  - `isAdultKeywordMatch(foldedText: string): boolean`: strict word/token boundary match against adult tokens (`18+`, `+18`, `xxx`, `adult`, `adults`, `erotic`, `erotica`, `porn`, `porno`, `nsfw`, `yetiskin`, `for adults`) without matching substrings like `adultery` or `1800`.
  - `parseRatingAge(ratingValue: string | null | undefined): number | null`: normalizes common ratings (`TV-MA`/`NC-17`/`R`/`X`/`18+`/`18` -> `18`, `16+`/`16` -> `16`, `15` -> `15`, `TV-14`/`14+`/`14` -> `14`, `PG-13`/`13+`/`13` -> `13`, `12+`/`12`/`PG` -> `12`, `TV-PG`/`7+`/`7` -> `7`, `G`/`TV-G`/`TV-Y` -> `0`).
  - `pinSecretKey(profileId)`: `profile.${profileId}.pin`
  - `hashParentalPin(pin, saltHex?)` & `verifyParentalPinHash(pin, stored)`: pure-TS 10,000-round iterated `sha256Hex` + constant-time hex comparison + 4..8 ASCII digit validator.
  - Per-profile in-memory PIN attempt rate-limiter (`MAX_PIN_ATTEMPTS = 5`, `PIN_LOCKOUT_MS = 30_000`) returning `{ ok: true }` or `{ ok: false, lockedUntilMs?, remainingAttempts }`.

- **`parental-repo.ts`** & **query filter integration**:
  - `getParentalSettings(db, profileId)`, `updateParentalSettings(db, profileId, patch, clock)`
  - `listParentalLocks(db, profileId, filter?)`, `setParentalLock(db, input, locked, clock)`
  - `loadActiveParentalFilter(db, profileId, parentalUnlocked)`: returns `null` when `parentalUnlocked === true` or (`!settings.enabled && locks.length === 0`) so default queries execute with zero overhead; otherwise returns `ActiveParentalFilter` (`lockedCategories`, `lockedItems`, `blockAdultKeywords`, `maxRatingAge`).
  - Query filtering applied across:
    - `queryCategories`: excludes locked categories and adult-keyword categories when active filter applies.
    - `queryItems`, `queryItemsByCursor`, `queryAllSourcesItems`, `queryAllSourcesItemsByCursor`, `queryAlphabetIndex`: excludes items locked directly OR placed in a locked/adult-keyword category OR matching adult keywords.
    - `querySearch`, `querySearchSuggestions`: excludes restricted live/movies/series/episodes/EPG programmes (including programmes exceeding `maxRatingAge`!).
    - `queryNowNext`, `queryEpgWindow`, `queryCrossChannelEpgSlice`: strips restricted channels and masks/filters age-restricted programme entries.
    - `queryChannelByNumber`: accepts `profileId` (fixes hardcoded `DEFAULT_PROFILE_ID`!) and skips restricted channels.
    - `queryItemDetail`, `resolveStream`: checks item/category restriction; `resolveStream` returns `err(elvError('auth', 'parental-locked'))` when locked.
    - `listContinueWatching`, `listFavorites`, `listRecentChannels`: filters out items restricted under the active profile's parental filter.

---

## 3. Per-Profile Preferences (`@elv/domain`)

In `packages/domain/src/preferences.ts`:
- `profilePreferencesKey(profileId: string): string`: returns `'elv.preferences.v1'` for `'default'` and `'elv.preferences.v1.' + normalizedId` for custom profiles (strictly `[A-Za-z0-9._-]+`).
- `ACTIVE_PROFILE_PREF_KEY = 'elv.active-profile.v1'`
- `ProfilePreferencesManager extends PreferencesStore`:
  - `getActiveProfileId(): string`
  - `switchProfile(profileId: string): Promise<PreferencesSnapshot>` (flushes pending debounced write on the outgoing profile, switches active profile key, hydrates incoming snapshot from cache or backend, notifies subscribers in one atomic state flip — zero blank flash!)
  - `deleteProfilePreferences(profileId: string): Promise<void>` (evicts cache & calls `backend.delete?.(profilePreferencesKey(profileId))`)
  - `loadActiveProfileId(): Promise<string>` / `saveActiveProfileId(profileId: string): Promise<void>`
- Mobile/TV (`apps/tv-mobile/src/storage/preferences.ts`) and Desktop (`apps/desktop/renderer/src/storage/preferences.ts`) adopt `createProfilePreferencesManager` seamlessly while staying 100% compatible with existing `PreferencesStore` consumers.

---

## 4. Desktop IPC & Utility Process (`apps/desktop/`)

Extend the 6 synchronized IPC files:
- `src/shared/catalog-ipc.ts` & `src/shared/catalog-ipc-guards.ts`
- `src/preload/catalog-bridge.ts`
- `src/utility/catalog-worker-runtime.ts`
- `renderer/src/catalog/desktop-catalog.ts`
- `renderer/src/App.tsx` (passes `profilePreferences` manager into `AppProviders` / `AppShell`).

New RPC methods:
`listProfiles`, `createProfile`, `updateProfile`, `deleteProfile`, `getParentalSettings`, `updateParentalSettings`, `listParentalLocks`, `setParentalLock`, `hasParentalPin`, `setParentalPin`, `verifyParentalPin`, `clearParentalPin`.
Extended query/stream RPC options: optional `profileId?: string` and `parentalUnlocked?: boolean` validated strictly via guards (`isOptionalProfileId`, `isOptionalBoolean`).

---

## 5. Cinema Quietude v2 UI & UX (`@elv/i18n`, `@elv/features`)

1. **Navigation Placement (`docs/design/UI_UX_PHILOSOPHY.md` §2.1 & §2.2):**
   - Keep the top-level **4 primary destinations (`Home`, `Live TV`, `Movies`, `Series`)** untouched.
   - Add a quiet, surface-aware **Profile monogram chip** in the top-right utility cluster (`Profile` utility opening the in-tree `ProfilePickerOverlay` when multiple profiles exist or from Settings -> `Profiles & Parental`).
   - Add a `'profiles'` section (`Profiles & Parental`) inside `SettingsScreen.tsx` & `useTvSettingsNavigation.ts` (2-column sidebar on Landscape, `EditorialCategoryBar` tab on Portrait, full TV D-pad focus support).

2. **Components (`packages/features/src/profiles/`):**
   - `ProfileAvatarBadge.tsx`: crisp monogram circle derived from theme tokens + `avatarToken` (zero hardcoded hex, optional small `Kids` pill).
   - `ProfilePickerOverlay.tsx`: in-tree Cinema Quietude overlay (ZERO RN `<Modal>` on TV!) displaying profile cards (`10-ft D-pad` focus ring, touch, pointer), instant switch, `+ Add profile` flow, and quick link to `Settings -> Profiles & Parental`.
   - `PinEntryOverlay.tsx`: in-tree 10-ft TV D-pad + touch + desktop keyboard numeric keypad (`0–9`, backspace, clear, cancel), masked dots (`••••`), wrong-PIN error + lockout timer message, supporting `'verify' | 'create' | 'confirm'` modes without ever logging or persisting plaintext PINs.
   - `ProfilesAndParentalPanel.tsx`: inside Settings (`profiles` section):
     - Profile management list (Switch, Create, Rename, Avatar picker, Kids toggle, Delete with confirmation & last-profile guard).
     - Parental Controls section (gated behind `PinEntryOverlay` when a PIN is set!): Set/Change/Remove PIN, Enable Parental Controls toggle, Block Adult Keywords toggle, Max Age Rating selector (`Off`, `7+`, `12+`, `14+`, `16+`, `18+`), Session Unlock Timeout (`15m`, `30m`, `60m`, `Session`), Temporary Unlock / Lock Now button, and Category Lock list (Live / Movies / Series category lock toggles persisted across imports).

3. **`AppShell.tsx` Integration & Zero-Blink Invalidation:**
   - Loads `profiles` + saved `activeProfileId` on startup; falls back cleanly to `'default'`.
   - Holds `parentalUnlocked` state + automatic expiry timer (`unlockTimeoutMin * 60_000`) + resets to locked on profile switch or app background.
   - Invalidates `uiCache`, `focusMemory`, `liveMemory`, `catalogMemoryByTab`, `detailStack`, and `recentSearches` whenever `activeProfileId` or `parentalUnlocked` changes.
   - Threads `profileId` and `parentalUnlocked` into Home, Live, Movies, Series, Detail, Search, Quick Actions, and Player (`watchProgress`, `favorites`, `trackPreferences`, `recentChannels`, `nextEpisode`, `resolveStream`).
   - Handles `auth/parental-locked` playback errors gracefully by offering the in-tree `PinEntryOverlay` to unlock and retry immediately.

4. **i18n (`@elv/i18n`):**
   - 100% EN and TR Lingui catalog parity across `.po` and compiled `.ts` files.

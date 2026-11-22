# 0014 Persistent User Data Storage on tvOS and iOS

- Status: Accepted
- Date: 2026-11-22

## Context and problem

On tvOS hardware, Apple does not grant apps persistent local filesystem directories (`Documents/` is unavailable for persistent data). Apps may store only purgeable caches (`Library/Caches`) plus approximately `500 KB` in `NSUserDefaults`. Accordingly, the device catalog (ADR 0005, `#72`) places `catalog.db` inside `Library/Caches` on Apple platforms (`ios`, `ipados`, `tvos`) so large provider catalogs stay purgeable on tvOS and avoid iCloud backup bloat on iOS.

Non-secret source definitions already survive a `Library/Caches` purge via a small source manifest (`elv.catalog.sources`) persisted in `NSUserDefaults` (`reconcileManifest`), while provider credentials remain strictly in Apple Keychain (`createSecureSecretStore`). However, user-authored local data — **favorites**, **watch progress**, and future **local profiles** (`#15`) — cannot be re-fetched from an IPTV provider and would be silently lost whenever tvOS purges `Library/Caches`.

## Decision drivers

- **Guaranteed local-first survival on tvOS:** Favorites, watch progress, and local profile metadata must survive a `Library/Caches` purge even when the user is offline, not signed into iCloud, or running an unentitled / local development build.
- **Measured platform storage ceilings:** Never exceed tvOS's `500 KB` `NSUserDefaults` cap (which triggers `NSUserDefaultsSizeLimitExceededNotification` and drops writes) or `NSUbiquitousKeyValueStore`'s `1 MB` / `1,024`-key cap.
- **Zero credentials outside Keychain:** No password, token, credentialed playlist URL, or URL containing `userinfo` or auth query parameters may ever be serialized into `NSUserDefaults` or iCloud KVS.
- **Fast rebuildable SQLite cache:** SQLite (`catalog.db`) remains the runtime query engine for browsing, continue watching, and unplayed-count joins; user tables rebuild atomically from the backing store after a cache purge.

## Measured storage limits & payload density

| Backing store | Apple platform ceiling | ELV allocated ceiling | Availability |
|---|---|---|---|
| `NSUserDefaults` (`elv.preferences.v1`) | `500 KB` app-wide on tvOS (`512,000` bytes) | `4 KB` (`4,096` UTF-8 bytes) | Always available locally (offline, unsigned, simulator) |
| `NSUserDefaults` (`elv.catalog.sources`) | Shared within `500 KB` app-wide cap | `~16 KB` (~25 sources) | Always available locally |
| `NSUserDefaults` (`elv.catalog.userstate.v1`) | Shared within `500 KB` app-wide cap | **`384 KB` (`393,216` UTF-8 bytes)** | Always available locally (guaranteed fallback) |
| `NSUbiquitousKeyValueStore` (`elv.catalog.userstate.v1`) | `1 MB` (`1,048,576` bytes) across `<= 1,024` keys | **`900 KB` (`921,600` UTF-8 bytes)** | Active when iCloud KVS entitlement & account are present |
| CloudKit (`CKDatabase`) | Quota-backed private database | Deferred (`#26` E2EE sync) | Requires paid iCloud container entitlement & iCloud sign-in |

Measured compact JSON tuple density in UTF-8 (versioned schema `v: 1`):
- **Favorite entry** (`profileId`, `sourceId`, `itemKey`, `kind`, `title`, sanitized `logo`, `year`, `rating`, `addedAt`): `~140–220` bytes/row -> `500` favorites occupy `~95 KB`.
- **Watch progress entry** (`profileId`, `sourceId`, `itemKey`, `kind`, `title`, `subtitle`, sanitized `logo`, `seriesKey`, `season`, `episode`, `positionMs`, `durationMs`, `watched`, `updatedAt`): `~210–300` bytes/row -> `500` entries occupy `~135 KB`.
- **Local profile entry** (reserved optional `profiles` slot for `#15`: `id`, `name`, `avatar`, `isKids`, `createdAt`): `~90` bytes/row -> `8` profiles occupy `< 1 KB`.

Combined typical heavy usage (`500` favorites + `500` progress rows + `8` profiles) consumes `~230 KB`, fitting comfortably inside both the `384 KB` local `NSUserDefaults` budget (leaving `> 100 KB` headroom under tvOS's `500 KB` ceiling alongside preferences and source manifest) and the `900 KB` iCloud KVS ceiling.

## Considered options

1. **CloudKit (`CKDatabase`) only:** Rejects offline Apple TV users, signed-out devices, and unentitled local simulator/community builds. Better suited for opt-in cross-device E2EE sync (`#26`).
2. **iCloud `NSUbiquitousKeyValueStore` with `NSUserDefaults` local fallback (chosen):** Uses `NSUbiquitousKeyValueStore` (`900 KB` ceiling) when entitled and available, while always mirroring a strictly byte-budgeted (`<= 384 KB`) snapshot to `NSUserDefaults` as a guaranteed local fallback. SQLite tables (`favorites`, `watch_progress`, and future `profiles`) act as the runtime cache rebuilt atomically alongside `reconcileManifest` on startup after a `Library/Caches` purge.
3. **Moving `catalog.db` out of `Library/Caches`:** Impossible on tvOS hardware, where non-cache persistent directories are prohibited by the OS.

## Decision outcome

On Apple platforms (`Platform.OS === 'ios'`, covering iOS, iPadOS, and tvOS):

1. **Primary home + guaranteed local fallback:** User data (`favorites`, `watch_progress`, and the forward-compatible `profiles` array for `#15`) is mirrored to a versioned (`v: 1`) snapshot under key `elv.catalog.userstate.v1` via a small native bridge in `@elv/engine-aether`:
   - Reads prefer `NSUbiquitousKeyValueStore.default` when the app carries the `com.apple.developer.ubiquity-kvstore-identifier` entitlement and returns a valid snapshot, falling back cleanly to `NSUserDefaults.standard`.
   - Writes persist to `NSUbiquitousKeyValueStore.default` (up to `900 KB` UTF-8) when entitled and always write a strictly byte-clamped snapshot (`<= 384 KB` UTF-8) to `NSUserDefaults.standard` so local purge recovery works without iCloud and never hits tvOS's `500 KB` ceiling.
2. **Deterministic budget eviction:** When the serialized snapshot exceeds the active byte ceiling, encoding preserves all profile records first, then favorites ordered by `addedAt DESC`, then watch progress prioritizing active in-progress rows (`watched = false`, `updatedAt DESC`) ahead of older completed entries until the UTF-8 payload is strictly `<= maxBytes`.
3. **Startup reconciliation after cache purge:** Immediately after `openCatalog(db)` and `reconcileManifest(db, manifest)`, `reconcileUserData(db, userData)` checks whether `favorites` and `watch_progress` are both empty. If empty and the backing store holds a valid snapshot, it restores all valid rows in one SQLite transaction (`INSERT OR IGNORE`) before the UI reads catalog state. If SQLite already holds user rows, it refreshes the backing store snapshot.
4. **Mutation mirroring:** Every mutating user-state operation in `CatalogService` (`saveProgress`, `setWatched`, `clearProgress`, `toggleFavorite`, `setFavorite`, `removeSource`) asynchronously updates the backing store (already coalesced over `500 ms` by `createCoalescedCatalog` in `apps/tv-mobile`).
5. **Credential isolation:** Every logo URL is stripped if it carries URL `userinfo`, sensitive query parameters, or a non-`http(s)` scheme before serialization. Provider passwords, playlist URLs, and future profile PIN hashes stay exclusively in Apple Keychain (`createSecureSecretStore`).

### Consequences

- **Good:** Favorites and watch progress reliably survive `Library/Caches/catalog.db` purges on tvOS hardware and Apple TV simulators with zero network or iCloud sign-in requirement, while automatically gaining iCloud KVS capacity (`900 KB`) once signed with an iCloud entitlement.
- **Good:** Zero breaking changes to SQLite schema or `CatalogService` callers; pure encode/decode/reconcile logic in `@elv/data` achieves full unit-test coverage.
- **Trade-off:** Extremely large historical watch logs (thousands of completed items) on unentitled local tvOS devices prune oldest completed entries past `384 KB` while keeping favorites and active in-progress items intact.

## Links

- Issue `#79` (Persist user data on tvOS hardware)
- [ADR 0005: Data layer](0005-data-layer.md)
- [ADR 0013: Security architecture and gate](0013-security-architecture-and-gate.md)
- [Device catalog spec](../superpowers/specs/2026-11-14-device-catalog-design.md)

# Wave F2 — Living-Room Ergonomics Design (`#60`, `#50`, `#33`, `#273`)

**Date:** 2026-11-24  
**Issues:** `#60` (Channel Management & Custom Groups), `#50` (Phone-to-TV QR LAN Pairing), `#33` (Remote Key Remapping), `#273` (Android TV Home Screen Preview Channels)  
**Design Language:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — zero hardcoded hex colors in UI (except explicit high-contrast QR module/quiet-zone surfaces), zero React Native `<Modal>` on TV, zero-blink `CatalogUiCache` invalidation, 100% EN/TR Lingui parity, strict clean-room hygiene.

---

## 1. `#60` — Channel Management (Rename, Hide, Reorder, Custom Groups)

### 1.1 Schema Migration v15 (`packages/data/src/schema-v15.ts`)
- `channel_overrides (profile_id TEXT NOT NULL DEFAULT 'default', item_key TEXT NOT NULL, source_id TEXT NOT NULL, custom_name TEXT, is_hidden INTEGER NOT NULL DEFAULT 0, sort_order INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (profile_id, item_key)) WITHOUT ROWID`
  - Index: `idx_channel_overrides_source (source_id)`
- `custom_groups (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL DEFAULT 'default', name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, is_hidden INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`
  - Index: `idx_custom_groups_profile (profile_id, sort_order)`
- `custom_group_items (group_id TEXT NOT NULL, item_key TEXT NOT NULL, source_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (group_id, item_key)) WITHOUT ROWID`
  - Index: `idx_custom_group_items_group (group_id, position)`
  - Index: `idx_custom_group_items_source (source_id)`
- All 3 tables registered in `EXPECTED_TABLE_COLUMNS`, `verifyAndHealSchema`, `TABLES_BY_SOURCE` (`finishDeletingSource`), `deleteProfile` cascade, `catalog-commit.ts` (`migrateLegacyKeysForTable` remapping `item_key` across M3U key migrations), and `user-state-backup.ts` (compact optional v1-compatible snapshot sections within size caps).

### 1.2 Query-Layer Projection & `CatalogService` APIs
- Every live query (`queryCategories`, `queryItems`, `queryItemsByCursor`, `queryAllSourcesItems`, `queryAlphabetIndex`, `queryItemDetail`, `search`, `searchSuggestions`, `queryChannelByNumber`, `queryLiveVariants`, `listRecentChannels`, `listFavorites`) applies per-profile `channel_overrides`:
  - Effective display title: `COALESCE(NULLIF(co.custom_name, ''), live.name)`.
  - Hidden channels (`co.is_hidden = 1`) are excluded unless `includeHidden: true` (used exclusively in the management UI so users can unhide channels).
  - Effective ordering: when `sortBy` is default/manual, `CASE WHEN co.sort_order IS NULL THEN 1 ELSE 0 END, co.sort_order ASC` precedes provider `position`.
  - Search (`searchKind`) matches renamed custom titles (`custom_name`) as well as indexed FTS titles.
  - Custom groups appear as synthetic category IDs `__custom:<groupId>` (prefix `CUSTOM_GROUP_CATEGORY_PREFIX = '__custom:'`) on live `categories`/`items`/`epgWindow` queries, honoring parental controls (`#31`).
- New optional `CatalogService` methods (also bridged in `write-coalescer.ts`, `lazy-catalog.ts`, `profile-scoped-catalog.ts`, `app-shell-state.ts`, and `apps/desktop` IPC with strict guards):
  - `listChannelOverrides?(profileId?: string): Promise<ChannelOverrideRecord[]>`
  - `setChannelOverride?(input: SetChannelOverrideInput): Promise<Result<ChannelOverrideRecord>>`
  - `clearChannelOverride?(itemKey: string, profileId?: string): Promise<Result<void>>`
  - `reorderChannels?(itemKeys: readonly string[], sourceId: string, profileId?: string): Promise<Result<void>>`
  - `listCustomGroups?(profileId?: string, opts?: { includeHidden?: boolean }): Promise<CustomGroupRecord[]>`
  - `createCustomGroup?(input: CreateCustomGroupInput): Promise<Result<CustomGroupRecord>>`
  - `updateCustomGroup?(groupId: string, patch: UpdateCustomGroupPatch): Promise<Result<CustomGroupRecord>>`
  - `deleteCustomGroup?(groupId: string): Promise<Result<void>>`
  - `setCustomGroupItems?(groupId: string, items: readonly { itemKey: string; sourceId: string }[]): Promise<Result<void>>`
  - `addChannelToCustomGroup?(groupId: string, itemKey: string, sourceId: string): Promise<Result<void>>`
  - `removeChannelFromCustomGroup?(groupId: string, itemKey: string): Promise<Result<void>>`

### 1.3 Cinema Quietude v2 UI
- Wire `onHideChannel` in `LiveScreen.tsx` -> `LiveContextMenu` and `EpgGridView` so users can hide a channel in one step from Live TV or the Guide.
- Add `ChannelManagementOverlay` / `ChannelManagementPanel` (accessible from Live TV context menu & Settings -> Live TV, zero RN `<Modal>`, 10-ft TV D-pad move-up/move-down, rename via `TvTextInput`/`TextEntryBoundary`, hide/unhide toggle, custom group creation/rename/delete/assignment).
- Mutations bump `CatalogUiCache` / `catalogRevision` so Live TV reflects changes immediately with zero blink.

---

## 2. `#50` — Add a Source from a Phone via QR Code (LAN Pairing)

### 2.1 Zero-Dependency QR Matrix & Renderer (`@elv/ui-kit`)
- Pure TypeScript QR Code (Byte mode, Version 1–10, Error Correction Level M, Reed-Solomon GF(256), all 8 mask penalty scores, finder/alignment/timing/format/version patterns) in `packages/ui-kit/src/components/qr-matrix.ts` (zero external dependencies, unit-tested for structural validity & deterministic payload encoding).
- `<QrCodeView value={url} size={220} />` rendering crisp `<View>` rows/modules on an explicit high-contrast white quiet zone (`#FFFFFF` backdrop + `#000000` modules — documented camera-scannability exception to dark surface tokens).

### 2.2 Ephemeral LAN Pairing Protocol & Security Model
- Shared protocol helpers in `packages/sources/src/lan-pairing-protocol.ts` (pure TS, no `node:*`):
  - Generates pairing URL `http://<lanIp>:<port>/pair/<sessionToken>` with single-use >= 128-bit hex token and 5-minute TTL.
  - Validates LAN peer addresses strictly (RFC1918 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6 ULA `fc00::/7`, link-local `fe80::/10`, plus loopback `127.0.0.1`/`::1` for local automated tests). Rejects public WAN peers.
  - Enforces matching `Host` header, same-origin `Origin` check on `POST`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `16 KiB` body cap, and max 5 failed attempts lockout.
  - Serves a self-contained mobile-responsive HTML form (M3U URL or Xtream server/username/password + optional source name + optional EPG URL) with zero external CDN requests and zero `window.crypto.subtle` dependency (works reliably over plain LAN HTTP on iOS Safari & Android Chrome).
  - Never logs submitted credentials, URLs, or request bodies anywhere.
  - Immediately closes the listener on first valid submission, TTL expiry, or UI close.

### 2.3 Native & Desktop Hosts (`LanPairingPort`)
- Define `LanPairingPort` in `packages/features/src/ports/lan-pairing-host.ts` (`startSession()`, `stopSession()`, `onPayloadReceived`).
- **Desktop (`apps/desktop`):** Main-process `node:http` server (`apps/desktop/src/main/lan-pairing-server.ts`) + preload IPC bridge (`lanPairing`).
- **Mobile/TV (`modules/lan-pairing`):** Expo native module:
  - Android (`ElvLanPairingModule.kt`): `java.net.ServerSocket(0)` on background executor, LAN IPv4 discovery via `NetworkInterface` (preferring non-loopback `wlan`/`eth` RFC1918), strict LAN peer validation, `Cache-Control: no-store`, single-use teardown on submit/destroy.
  - Apple (`ElvLanPairingModule.swift`): `Network.framework` `NWListener` (iOS + tvOS) with `getifaddrs` LAN IPv4 discovery (`en0`/`en1`), strict RFC1918 peer check, single-use teardown. (Preserves `NSAppTransportSecurity` invariant: never adds `NSAllowsLocalNetworking` alongside `NSAllowsArbitraryLoads`.)
- **UI (`packages/features/src/sources/QrPairingPanel.tsx`):** Accessible from `SourcesScreen` ("Scan QR from phone" button, prominently placed on TV/Desktop). Displays QR code, human-readable fallback URL, live TTL countdown, "New code" regenerate button, and automatic source creation via `CatalogService.addSource` / `addSourceFromLink` upon submission.

---

## 3. `#33` — Remote Key Remapping

### 3.1 Pure Remap Engine (`packages/focus-core/src/keymap.ts`)
- Context-scoped remappable actions (`RemapContext = 'player' | 'live' | 'global'`):
  - `player`: `togglePlayPause`, `seekBack`, `seekForward`, `channelUp`, `channelDown`, `lastChannel`, `openChannelDrawer`, `openSettings`, `cycleAudioTrack`, `cycleSubtitleTrack`, `toggleMute`, `openInfo`, `toggleGuide`.
  - `live`: `lastChannel`, `toggleGuide`, `openSearch`, `toggleFavorite`.
  - `global`: `openSearch`, `openGuide`, `openHome`.
- Binding descriptor: `{ key: Key; kind: 'press' | 'long' }`.
- **Immutable Navigation Safety Invariant:** Short-press `up`, `down`, `left`, `right`, `select`, and `back` (`isImmutableNavTrigger`) CANNOT be rebound globally or in ways that orphan Settings navigation (`validateKeyBinding` rejects them). Long-press `select` / `back` remain remappable only where safe.
- `resolveRemappedAction(keymap, context, event)` resolves user overrides with fallback to `DEFAULT_KEY_BINDINGS`, handles conflict displacement cleanly (assigning a key to Action B unbinds it from Action A in the same context), and exports `collectLongPressKeys(keymap)` so `useKeyInterpreter` dynamically includes any keys bound to `'long'` triggers!

### 3.2 Dedicated Sparse Storage (`packages/domain/src/keymap-store.ts`)
- Stored separately from `elv.preferences.v1` under `KEYMAP_PREF_KEY = 'elv.keymap.v1'` (or profile-scoped `'elv.keymap.v1.<profileId>'`) as sparse delta-only JSON (`{ v: 1, overrides: { ... } }`) so Android `expo-secure-store`'s `2048 B` preference cap is NEVER breached!

### 3.3 Feature Wiring & Settings Capture UI
- Route `player-key-routing.ts`, `usePlayerControls.ts`, `useTvLiveNavigation.ts`, and `LiveScreen.tsx` (including web `'p'` shortcut) through the resolved keymap.
- Add `'remote'` section (or dedicated Remote Keys panel inside Settings -> `settings.section.remote`) in `SettingsScreen.tsx` & `useTvSettingsNavigation.ts` using `useTvKeyInterceptor` for live "Press any remote button…" capture, conflict preview, per-action reset, and "Reset all defaults".

---

## 4. `#273` — Android TV Home Screen Preview Channels (`TvContractCompat` + `FileProvider`)

### 4.1 Dedicated Expo Native Module (`modules/tv-home-channels`)
- Android-only runtime module (safe no-op on iOS/tvOS/web and non-Leanback / `< API 26` Android devices):
  - `android/build.gradle`: adds `implementation 'androidx.tvprovider:tvprovider:1.0.0'` (Apache-2.0) + Robolectric/JUnit unit tests.
  - `android/src/main/AndroidManifest.xml` + `res/xml/elv_tv_channels_paths.xml`: declares `androidx.core.content.FileProvider` (`authorities="${applicationId}.tvchannels.fileprovider"`, `exported="false"`, `grantUriPermissions="true"`) serving cached logos from `cache-path` `tv_channel_logos/`.
  - Syncs at most 2 bounded channels (`Continue Watching` and `Favorites` / `Live Channels`, max 20 programs each):
    - Respects `COLUMN_BROWSABLE`: if the user removed a channel from the Android TV home screen, never re-creates or forces it back.
    - Downloads channel/title logos with strict SSRF checks (blocks private/loopback/link-local IPs, non-HTTP(S) schemes, SVG, oversized bodies > 2 MiB), writes to `cacheDir/tv_channel_logos/`, exposes via `FileProvider.getUriForFile(...)`, and grants `FLAG_GRANT_READ_URI_PERMISSION` to Android TV launcher packages (`com.google.android.tvlauncher`, `com.google.android.apps.tv.launcherx`, and resolved `CATEGORY_LEANBACK_LAUNCHER` packages).
    - Program `appLinkIntentUri` is strictly `elviptv://play?key=<encodeURIComponent(itemKey)>` (plus optional `&kind=live|movie|episode`), NEVER raw stream URLs, hostnames, or credentials.

### 4.2 Production Deep-Link Handling & Sync Port
- Define `TvHomeChannelsPort` in `packages/features/src/ports/tv-home-channels.ts` (`syncChannels(payload)`, `clearChannels()`).
- Wire `apps/tv-mobile/src/tv-home-channels/adapter.ts` bridging `@elv/tv-home-channels` and `apps/tv-mobile/src/App.tsx`:
  - Production `Linking.getInitialURL()` + `Linking.addEventListener('url', ...)` parses `elviptv://play?key=...` (`parsePlayDeepLink` pure helper in `packages/features/src/ports/play-deep-link.ts`) and passes the deep-link target into `AppShell` -> resolves via `catalog.itemDetail(itemKey)` (honoring active profile & parental lock!) -> plays strictly via play-time `resolveStream`.
  - Throttled idempotent sync triggered when `catalogRevision`, favorites, watch progress, or active profile change (and when active profile is Kids or has parental controls enabled, strictly respects parental-filtered queries so restricted items NEVER appear on the Android TV launcher!).

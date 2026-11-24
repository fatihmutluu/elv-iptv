# Wave F5A — Multi-Source Failover, Stream Health Scoring, Split Xtream Failover & Advanced Network Settings

**Date:** 2026-11-24  
**Issues:** `#157`, `#167`, `#195`, `#317`, `#172`  
**Workstream:** `cluster:sources-data`, `cluster:player-osd` (Epic `#345`)  
**Design Alignment:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`), Foundation Spec §5.2 & §6.2, Zero-Credentials-in-SQLite invariant.

---

## 1. Goals & Scope

Wave F5A hardens multi-provider streaming resilience and per-source network control across five tightly coupled capabilities:

1. **Multi-Source Failover Channel Groups (`#157`):** Let users group identical live channels from multiple M3U/Xtream sources into prioritized failover groups (with automatic name/`tvg-id` clustering suggestions and user reorder priority), feeding Rung-4 recovery alternates while respecting each source's `max_connections` limit.
2. **TTL-Bounded Passive Stream Health Cache & Idle-Probe Cancellation (`#167`):** Maintain a bounded in-memory passive health cache (`4,096` entries, `6-hour` TTL) keyed by credential-free canonical stream key updated from real tune/stall/recovery outcomes, expose non-blocking subtle health indicators in live browse/zap surfaces, and immediately abort any idle background probe on user tune or navigation (while skipping single-connection sources).
3. **Time-Decayed Stream Health Scoring in Rung-4 Failover (`#195`):** Maintain a bounded (`300`-entry) exponentially time-decayed runtime health scorer combining stall counts, failure penalties, time-to-first-frame (TTFF), and buffer depth to rank failover alternates in `packages/playback/src/ladder.ts` while preserving user priority order on ties or once penalties decay back to baseline.
4. **Independent Xtream API vs. Stream Server Failover (`#317`):** Split `activeApiServer` and `activeStreamServer` in `@elv/sources` (`xtream.ts`, `xtream-mirrors.ts`) with independent `primaryCooldownMs` (default `5 min`) promotion timers and session-launch reset so stream edge failures never disrupt `player_api.php` metadata requests and streams recover back to the primary server once healthy.
5. **Per-Source IPv4/IPv6 DNS Preference & Validated Host Override (`#172`):** Add optional `dnsFamily?: 'system' | 'ipv4' | 'ipv6'` and validated literal-IP `hostOverride?: string` to `TransportSettings`, persisted in `SourceSettings`, wired cleanly into Android Media3 OkHttp `Dns`, Desktop Node HTTP `dns.lookup` (strictly preserving TLS SNI and certificate verification and never leaking across cross-origin redirects), Apple load options, and Sources Advanced Network Settings UI.

---

## 2. Clean-Room Architectural Design

### 2.1 `@elv/domain` — Transport & Validation (`#172`)
- **`packages/domain/src/network-transport.ts`:**
  - `export type DnsFamilyPreference = 'system' | 'ipv4' | 'ipv6';`
  - `normalizeDnsFamily(raw: unknown): DnsFamilyPreference | undefined` — accepts `'system' | 'ipv4' | 'ipv6'`; ignores unknown values.
  - `isValidIpv4Literal(ip: string): boolean` and `isValidIpv6Literal(ip: string): boolean` — strict syntactic validators (zero regex ReDoS, handles compressed `::` IPv6 and bracketed `[...]` input, rejects ports, whitespace, schemes, paths, control chars, zone IDs).
  - `validateHostOverride(raw: string | undefined): Result<string | undefined>` — returns `ok(undefined)` for empty/whitespace; returns `ok(normalizedIp)` for valid IPv4/IPv6 literal (stripping optional `[...]`); returns `err(elvError('validation', 'invalid-host-override'))` otherwise.
- **`packages/domain/src/source.ts`:**
  - Extend `TransportSettings` with:
    - `readonly dnsFamily?: DnsFamilyPreference;`
    - `readonly hostOverride?: string;`
- **`packages/domain/src/http.ts`:**
  - Extend `HttpRequestOptions` with optional `readonly dnsFamily?: DnsFamilyPreference;` and `readonly hostOverride?: string;`.

### 2.2 `@elv/sources` — Independent API & Stream Mirror Failover (`#317`)
- **`packages/sources/src/xtream-mirrors.ts`:**
  - Introduce `createMirrorSlotState(serverCount, primaryCooldownMs, nowFn)` managing `{ activeIndex, failedOverAtMs }` with:
    - `attemptOrder(nowMs)`: returns `[0, 1, ..., n-1]` on primary, `[0, active, ...rest]` when `nowMs - failedOverAtMs >= primaryCooldownMs`, or `[active, ...others, 0]` during cooldown.
    - `markSuccess(idx, nowMs)`: promotes `idx`; clears `failedOverAtMs` when `idx === 0`.
    - `markPrimaryProbeFailed(nowMs)`: refreshes `failedOverAtMs` when a cooldown probe of index `0` fails.
    - `reportFailure(failedIdx, nowMs)`: if `failedIdx === activeIndex` and `serverCount > 1`, advances `activeIndex` to the next mirror and records `failedOverAtMs` if leaving primary (or refreshes cooldown on primary failure).
    - `reset()`: restores `activeIndex = 0`, `failedOverAtMs = undefined`.
- **`packages/sources/src/xtream.ts` & `xtream-types.ts`:**
  - Replace shared `activeIndex`/`failedOverAtMs` with independent `apiSlot` and `streamSlot` instances.
  - All `player_api.php` methods (`getJson`, `streamRows`, `playlistUrl`, `guideUrl`) read/mutate **only** `apiSlot`.
  - Stream methods (`streamUrl`, new `streamUrls(kind, id, extension?)`) read **only** `streamSlot`:
    - `streamUrls` returns ordered candidate URLs matching `streamSlot.attemptOrder(nowFn())` (first URL is the primary/preferred stream URL; remaining entries become failover alternates).
    - `activeApiServer(): string` and `activeStreamServer(): string` expose active resolved base URLs (host/scheme only; credentials stay internal).
    - `reportStreamFailure(failedUrlOrBase?: string): void` and `reportStreamSuccess(succeededUrlOrBase?: string): void` update **only** `streamSlot` by matching server host/origin against `servers`.
    - `resetMirrors(): void` resets both slots to index `0`.
  - Forward `transport?.dnsFamily` and `transport?.hostOverride` in `requestServerBody()` `http.get` options.

### 2.3 `@elv/playback` — Health Cache, Decayed Scorer & Connection-Safe Rung-4 (`#167`, `#195`, `#157`, `#172`)
- **`packages/playback/src/engine.ts` & `types.ts`:**
  - Add optional `readonly accountKey?: string;`, `readonly maxConnections?: number;`, `readonly sourceId?: string;`, `readonly channelKey?: string;`, `readonly dnsFamily?: DnsFamilyPreference;`, `readonly hostOverride?: string;` to `StreamRequest`.
  - Add optional `readonly dnsFamily?: DnsFamilyPreference;`, `readonly hostOverride?: string;` to `LoadOptions`.
- **`packages/playback/src/stream-health-cache.ts` (`#167`):**
  - `export type StreamHealthStatus = 'healthy' | 'flaky' | 'dead';`
  - `export interface StreamHealthEntry { readonly status: StreamHealthStatus; readonly consecutiveFailures: number; readonly stallCount: number; readonly lastOutcomeAtMs: number; readonly lastSuccessAtMs?: number; readonly lastFailureAtMs?: number; readonly lastTtffMs?: number; }`
  - `createStreamHealthCache({ maxEntries = 4_096, ttlMs = 6 * 3_600_000, clock })`:
    - Canonicalizes any raw URL input via `normalizeStreamUrl` (or accepts pre-canonicalized `itemKey`) so credentials never enter cache keys.
    - O(1) Map-based LRU eviction at `maxEntries` and TTL expiration at `ttlMs`.
    - `recordSuccess(key, ttffMs?)`, `recordStall(key)`, `recordFailure(key, terminal?)`, `get(key)`, `prune()`, `clear()`, `size()`, `subscribe(listener)`.
  - `createIdleProbeController()`:
    - `beginProbe(opts: { maxConnections?: number }): AbortSignal | null` — returns `null` (refuses probe) when `(opts.maxConnections ?? 1) <= 1` so single-connection IPTV panels are never probed in the background; otherwise registers an `AbortController` and returns its `AbortSignal`.
    - `abortAll(reason?: string): void` — immediately aborts every in-flight probe synchronously and clears the set.
    - `activeCount(): number`.
- **`packages/playback/src/stream-health-scorer.ts` (`#195`):**
  - `createStreamHealthScorer({ maxEntries = 300, halfLifeMs = 15 * 60_000, clock })`:
    - Tracks exponentially decaying `stallScore`, `failureScore`, `ttffAdjustment`, and `bufferAdjustment` per canonical credential-free stream key (`maxEntries` LRU).
    - Decay formula on read/update: `factor = Math.pow(0.5, Math.max(0, dtMs) / halfLifeMs)`.
    - `recordFirstFrame(key, ttffMs)`: lowers penalty / adds modest TTFF quality score (`<= 1_500 ms` small bonus, `> 5_000 ms` small penalty).
    - `recordStall(key)`: adds `-1.5` stall penalty.
    - `recordFailure(key)`: adds `-3.0` failure penalty.
    - `recordBufferDepth(key, bufferMs)`: bounded gentle adjustment (`[-0.5, +0.5]`) based on sustained buffer headroom.
    - `score(key, nowMs?) -> number`: decays cleanly toward `0` over time.
    - `rankAlternates<T>(items, keyOf, nowMs?)`: stable sort descending by decayed score; differences `< 0.01` preserve original index (user priority order from `#157`).
- **`packages/playback/src/service.ts`, `seam.ts`, `recovery.ts`, `ladder.ts`:**
  - Optional `PlaybackServiceDeps` hooks: `healthCache`, `healthScorer` (defaults to internal 300-entry scorer), `idleProbeController`, `canAcquireAlternate?: (accountKey: string, maxConnections: number) => boolean`, `onStreamOutcome?: (stream: StreamRequest, outcome: 'success' | 'failure') => void`.
  - In `service.tune()`: synchronously invoke `idleProbeController?.abortAll('tune')` before anything else.
  - Forward `stream.dnsFamily` / `stream.hostOverride` into `engine.load({ options })`.
  - Emit health outcomes on `firstFrame` (with TTFF = `atMs - tuneAt`), `stall` (`start`), `clock` (live/VOD buffer depth when available), and `error` / failed load.
  - In `ladder.ts`:
    - When entering Rung-4 alternate selection (`advanceAlternates`), rank remaining `inlineAlternates` using `healthScorer.rankAlternates(...)` (stable tie-break preserving `#157` group priority order).
    - Skip alternates that match `failedCanonicalUrls` OR fail `canAcquireAlternate(alt.accountKey, alt.maxConnections ?? 1)` (skipping saturated multi-source providers without triggering 509/403 bans, while still allowing same-account failover because `ctl.stopMedia()` closes the prior socket first).

### 2.4 `@elv/data` — Schema v17 Failover Groups, Auto-Clustering & Split Xtream Tracking (`#157`, `#317`, `#172`)
- **`packages/data/src/schema-v17.ts` (`SCHEMA_VERSION = 17`):**
  ```sql
  CREATE TABLE IF NOT EXISTS failover_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_fold TEXT NOT NULL,
    auto_matched INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS failover_group_members (
    group_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    channel_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (group_id, channel_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_failover_members_group ON failover_group_members (group_id, position);
  CREATE INDEX IF NOT EXISTS idx_failover_members_channel ON failover_group_members (channel_key);
  CREATE INDEX IF NOT EXISTS idx_failover_members_source ON failover_group_members (source_id);
  ```
- **`packages/data/src/failover-groups-repo.ts`:**
  - Data models: `FailoverGroupMember`, `FailoverGroupRecord`, `SuggestedFailoverCluster`.
  - Operations: `listFailoverGroups`, `getFailoverGroupByChannel`, `createFailoverGroup`, `renameFailoverGroup`, `deleteFailoverGroup`, `addFailoverGroupMember`, `removeFailoverGroupMember`, `reorderFailoverGroupMembers`, `pruneSourceFailoverMembers` (called during `removeSource`).
  - Auto-clustering (`suggestFailoverGroups`): normalizes live channel titles (stripping bracket/prefix tags like `[TR]`, `US:`, quality suffixes `4K|UHD|FHD|HD|SD|HEVC|H265|50FPS|60FPS|RAW|BACKUP`, and punctuation via Turkish-safe folding) and `guide_id`, proposing clusters spanning `>= 2` distinct sources while excluding channels already assigned to a failover group.
- **`packages/data/src/sources.ts` & `stream-resolver.ts`:**
  - Support optional `backupServers?: readonly string[]` in `XtreamSourceInput` / `XtreamSecret` (stored strictly in `SecretStore` inside `source.<id>.xtream` JSON — never SQLite!).
  - Validate `transport.dnsFamily` and `transport.hostOverride` in `addXtreamSource`, `addM3uSource`, `updateSourceSettings`.
  - Maintain a session-scoped `Map<sourceId, XtreamClient>` (evicted on source mutation/delete, reset on app launch) inside `PlaytimeResolverCache` so `streamSlot` state persists across tunes while `apiSlot` stays completely independent (`#317`)!
  - In `resolveStream(itemKey)`:
    - Forward `dnsFamily` and `hostOverride` from `source.settings.transport` onto `StreamRequest`.
    - For Xtream streams with backup servers, build primary URL from `client.streamUrls(...)` `[0]` and append backup mirror URLs `[1..N]` as `alternates`.
    - For live channels belonging to a `failover_groups` group, resolve sibling members in `position` order (deduplicated against self, skipping unavailable sources) and append them as `StreamAlternate` entries carrying each sibling's own `accountKey`, `maxConnections`, `sourceId`, `channelKey`, `headers`, `allowLegacyTls`, `dnsFamily`, and `hostOverride`.
  - Add `reportStreamOutcome(sourceId: string, serverUrl: string, ok: boolean): void` on `CatalogService` / `PlaytimeResolverCache` so playback feeds Xtream `streamSlot` promotion/failover cleanly without touching `apiSlot`.

### 2.5 Native & Desktop Platform Wiring (`#172`, `#157`)
- **Android Media3 (`modules/engine-media3/`):**
  - `LoadRequest.kt`: parse optional `dnsFamily` (`"system" | "ipv4" | "ipv6"`) and validated literal-IP `hostOverride` from load options.
  - `StreamHttp.kt`: add `ScopedDns(delegate: Dns, dnsFamily: DnsFamilyPreference, hostOverride: String?, overrideTargetHost: String?) : Dns`:
    - When `hostOverride != null && overrideTargetHost != null && hostname.equals(overrideTargetHost, ignoreCase = true)`, resolve strictly to `listOf(InetAddress.getByName(hostOverride))` (never applying to cross-origin redirects; OkHttp retains original URL hostname for TLS SNI + HostnameVerifier!).
    - When `dnsFamily == IPV4`, filter `delegate.lookup(hostname)` to `Inet4Address` (throwing `UnknownHostException` if empty).
    - When `dnsFamily == IPV6`, filter `delegate.lookup(hostname)` to `Inet6Address` (throwing `UnknownHostException` if empty).
  - `Media3Engine.kt`: derive per-load `OkHttpClient` via `baseClient.newBuilder().dns(ScopedDns(...)).build()` whenever `dnsFamily != SYSTEM || hostOverride != null` (sharing connection pool, dispatcher, cookie jar, and redirect interceptors).
- **Desktop Electron (`apps/desktop/`):**
  - `apps/desktop/src/utility/legacy-tls-http.ts`: extend custom Node HTTP/HTTPS transport so requests specifying `dnsFamily: 'ipv4' | 'ipv6'` OR `hostOverride` use Node `http.request`/`https.request` with a custom `lookup` honoring `family: 4 | 6` and exact-origin `hostOverride` while preserving `servername: parsed.hostname` (TLS SNI) and `rejectUnauthorized: true`.
  - `apps/desktop/src/shared/player-ipc.ts`: validate optional `dnsFamily` and `hostOverride` on `LoadCommand` / `LoadOptions`.
  - `apps/desktop/src/shared/catalog-ipc*.ts` + `apps/desktop/src/utility/catalog-worker*.ts` + `apps/desktop/src/preload/`: expose all new failover-group & `reportStreamOutcome` RPCs with strict runtime guards.
- **Apple AetherEngine (`modules/engine-aether/`):**
  - `AetherLoadOptions.swift` & `ElvEngineAetherModule.swift`: parse and validate optional `dnsFamily` and `hostOverride` cleanly without breaking `LoadOptions` decoding (and pass `NWProtocolIP.Options.version` on `NWConnection` paths if present; AVFoundation URL loads remain governed by iOS/tvOS transport stack while preserving TLS verification).

### 2.6 `@elv/i18n` & `@elv/features` UI (Cinema Quietude v2, Zero Hardcoded Hex, 100% EN/TR, Full 2D TV D-Pad)
- **`@elv/i18n` (`{en,tr}-failover-network.ts` + `.po`):**
  - Full EN/TR translations for Failover Groups tab (create, rename, delete, auto-match clusters, move up/down priority, add/remove member, member count, source priority badges), passive health badges (`Flaky`, `Unreachable`), and Advanced Network Settings (`DNS preference`: `System` / `IPv4` / `IPv6`, `Host IP override`, validation error hint, `Network` button on saved sources).
- **Failover Groups UI (`packages/features/src/live/FailoverGroupsTab.tsx`, wired into `ChannelManagementOverlay.tsx` as 3rd tab `'failover'`):**
  - Zero RN `<Modal>`, zero hardcoded hex colors, Cinema Quietude hairline surfaces (`theme.colors.surface`, `theme.colors.surfaceBorder`, `theme.colors.accent`).
  - Supports: Auto-Match Cross-Source Suggestions banner (1-click apply), Create Group, Rename/Delete Group, Add/Remove Channel Members, and **Move Up / Move Down priority reordering** (full TV D-pad Up/Down/Left/Right/Select/Back navigation + pointer click/touch controls).
- **Advanced Network Settings UI (`packages/features/src/sources/`):**
  - Add DNS Preference segmented selector (`System` / `IPv4` / `IPv6`) and optional Host IP Override field inside the add-source **Advanced** section (`SourcesScreen.tsx`, `validate.ts`, `useSourcesController.ts`, `useTvSourcesNavigation.ts`), AND a compact per-source Network Settings drawer/inline editor on saved sources in `SavedSourcesPanel.tsx` backed by `catalog.updateSourceSettings`.
- **Passive Health Indicators & Player Integration (`packages/features/src/live/`, `packages/features/src/player/`):**
  - Wire shared `StreamHealthCache`, `StreamHealthScorer`, and `IdleProbeController` into `AppProviders` / `PlayerScreen` / `usePlayerTargetHandoff` / `usePlayerSession`.
  - Abort `idleProbeController` synchronously on channel tune and route/category navigation.
  - Surface subtle Cinema Quietude status dot/badge on `LiveChannelTile` / `LiveZapRow` strictly when cached health is `'flaky'` or `'dead'` (never cluttering healthy channels!).
  - Feed `onStreamOutcome` back to `catalog.reportStreamOutcome` for Xtream split-mirror failover (`#317`).

---

## 3. Verification Plan
- **Strict TDD** across every package (`>= 90%` line coverage in pure packages `@elv/domain`, `@elv/sources`, `@elv/data`, `@elv/playback`).
- **Fake-clock deterministic tests** for:
  - `4,096`-entry LRU eviction, `6-hour` TTL expiration, and synchronous `AbortSignal` firing on `service.tune()` / navigation (`#167`).
  - `300`-entry time-decayed scoring: recently stalled alternate drops below healthy alternate, smoothly recovers weight after half-life, preserves user priority order on tie (`#195`).
  - Multi-source 3-member failover cascade, reorder persistence, auto-clustering across 2+ sources, and skipping alternates whose `max_connections` is full (`#157`).
  - Xtream stream failure switching `activeStreamServer` while `activeApiServer` remains on primary, and primary stream server automatically restored after `primaryCooldownMs` (`#317`).
  - Android Media3 Robolectric tests for `ScopedDns` (`ipv4` / `ipv6` filtering, exact-origin `hostOverride`, cross-origin non-leakage) + Desktop Node HTTP tests for `dnsFamily` & `hostOverride` with SNI verification (`#172`).
- **Full gates:** `pnpm check` (11/11 green), Android `:elv-engine-media3:testDebugUnitTest`, Apple `swift test` on `elv-mac`, independent `Gemini 4 Neon (High)` whole-branch code review (`VERDICT: PASS`), and full 16-job GitHub CI green!

# Wave P1 — Provider, Network, Cookie, EPG & Track Resilience (`#171`, `#229`, `#141`, `#87`, `#194`, `#217`, `#151`)

**Date:** 2026-11-22
**Branch:** `feat/provider-network-resilience`
**Closes:** `#171`, `#229`, `#141`, `#87`, `#194`, `#217`, `#151`

## 1. Goal

Harden real-world IPTV provider compatibility, offline/error resilience, EPG matching/fetching efficiency, connection-limit safety, and audio/subtitle/aspect parity across `@elv/domain`, `@elv/sources`, `@elv/data`, `@elv/playback`, `@elv/features`, Android Media3, Apple AetherEngine, and Desktop.

## 2. Design Decisions & Contracts

### 2.1 Per-Origin RFC 6265 Cookie Jar (`#171`)
- **`@elv/domain` (`packages/domain/src/cookie-jar.ts`):** Pure, bounded in-memory `CookieJar` (`createCookieJar({ maxCookies = 128, now })`) keyed strictly by exact `scheme://host:port` origin (`originOf(url)`).
  - Parses `Set-Cookie` headers (`Name=Value`, `Path`, `Expires`, `Max-Age`, `Secure`; ignores cross-origin `Domain` widening).
  - `store(url, setCookieHeaders)`: stores/updates/evicts (LRU/FIFO cap) cookies for `originOf(url)` only; drops expired (`Max-Age <= 0` or past `Expires`) entries.
  - `headerFor(url)`: returns `Cookie` header string for matching exact origin + RFC 6265 path match; NEVER emits `Secure` cookies over `http://` or across origins.
  - Never persisted to SQLite or disk.
- **`packages/domain/src/http.ts`:** `createFetchHttpClient` creates a per-request redirect cookie jar during its manual redirect loop (up to 10 hops), capturing `Set-Cookie` on 3xx responses and merging non-conflicting exact-origin cookies into the subsequent hop's `Cookie` header (while still stripping caller credential headers cross-origin).
- **Native Transports:** Mirror exact-origin per-session `Set-Cookie` jar in `modules/engine-media3/.../StreamHttp.kt` (`OriginCookieJar` wired into `StreamHttp` redirect handling) and `modules/engine-aether/ios/Core/StreamHttp.swift` + `URLSessionTransport.swift` (capturing `Set-Cookie` on 3xx responses and echoing strictly on matching `StreamOrigin` + path + `Secure` guard).

### 2.2 HTTPS-First Per-Session `SchemeCache` (`#229`)
- **`@elv/sources` (`packages/sources/src/xtream-scheme.ts`):**
  - `hasExplicitScheme(input: string): boolean` detects explicit `http://` or `https://`.
  - Per-`HttpClient` `WeakMap<HttpClient, Map<string, 'https' | 'http'>>` (`getCachedXtreamScheme`, `setCachedXtreamScheme`, `clearXtreamSchemeCache`, `normalizeXtreamServerWithScheme`).
  - When a user supplies a scheme-less host (e.g. `panel.example` or `panel.example:8443`), `xtream.ts` probes `https://` first on the first request (with a bounded TLS probe timeout) and falls back to `http://` **only** on transport/TLS/connect failure (never on HTTP 401/403/429/5xx panel responses), caching the winning scheme per host for all subsequent `getJson`, `streamRows`, `streamUrl`, `playlistUrl`, and `guideUrl` calls.
  - Explicit `http://` or `https://` inputs NEVER auto-switch schemes.

### 2.3 Cached-Catalog Status Strip & Live MPEG-TS Edge Jump (`#141`)
- **`@elv/data` (`runs.ts`, `catalog.ts`):** Expose `latestImportHealth(sourceId?)` returning the latest `import_runs` row (`status`, `errorCategory`, `errorCode`, `finishedAt`) alongside whether cached catalog items remain browsable. Failed refreshes never mutate or clear existing SQLite rows.
- **`@elv/features` (`CachedCatalogStrip.tsx`):** Non-blocking compact status strip rendered at the top of browse views when a source's latest refresh failed while cached items remain available, displaying a concise translated reason and a `"Check again"` retry action.
- **`@elv/playback` (`engine.ts`, `types.ts`, `service.ts`):** Expose optional `liveEdgeMs?: number` / `isLiveTs?: boolean` on clock/session state and `PlaybackService.jumpToLiveEdge(): boolean`, seeking strictly to `Math.max(0, liveEdgeMs - 3_000)` only when the active stream is a live MPEG-TS stream (never applied to HLS or VOD).

### 2.4 Connection Limit Tracking & Pre-Flight Warning (`#87`)
- **Research note (`docs/learned/README.md`):** Document Xtream `user_info.max_connections` (coerced: `<= 0` / empty / non-numeric -> `1`; M3U -> `1`), `active_cons` provider close-lag behavior, and why local per-`accountKey` counting is authoritative for in-app streams.
- **`@elv/data` (`sources.ts`, `catalog.ts`, `stream-resolver.ts`):** Store normalized `maxConnections` (`>= 1`, default `1`) and optional last-seen `providerActiveCons?: number` on `SourceAccountMeta` (and surface `maxConnections` on resolved `ResolvedStream`).
- **`@elv/playback` (`connection-tracker.ts`):** Pure `createConnectionTracker()` tracking active stream handles per `accountKey` (`acquire`, `release`, `activeCount`, `wouldExceedLimit({ accountKey, maxConnections, replacingStreamId?, providerActiveCons? })`). A channel zap passing `replacingStreamId` never double-counts.
- **`@elv/features` (`ConnectionLimitDialog.tsx`):** Three-option pre-flight dialog on TV, touch, and desktop (`Stop other stream` when an in-app stream is active / `Cancel` / `Continue anyway`) stating **only** known facts (`ownActiveCount` vs `providerActiveCons`, never guessing). Provider 509/403/notice responses remain authoritative `limited` transitions.

### 2.5 EPG CamelCase / Number-Word Folding & Title Cleaning (`#194`)
- **`@elv/data` (`fold.ts`, `guide-match.ts`):** Add `foldGuideMatchText(input)` (or integrate in `normalizeGuideName`) that splits CamelCase boundaries (`NewsOne` -> `news one`) and maps standalone English number words (`zero`..`nine` -> `0`..`9`) so `NewsOne HD` matches `News 1`.
- **`@elv/data` (`title-clean.ts`):** Shared `cleanDisplayTitle(raw: string): string` preserving trailing `(YYYY)` release years and leading numeric movie titles (`2001: A Space Odyssey`, `2001. A Space Odyssey`) while stripping leading curated service/region prefixes (`[TR]`, `UK |`, `FHD:`, etc.) and trailing 2-letter country codes (`(TR)`, `(US)`).

### 2.6 Bounded LIFO + TTL Lazy Short-EPG Queue (`#217`)
- **`@elv/data` (`short-epg-queue.ts`):** Pure `createShortEpgQueue<T>({ capacity = 60, ttlMs = 300_000, batchDelayMs = 150, fetchEntry, onBatch, now })`:
  - Bounded LIFO stack (`push` moves existing key to tail or drops oldest head entry when `size >= capacity`; worker pops most-recent item from tail).
  - Per-key TTL cache skips redundant fetches; rapid visible-row bursts coalesce into `~150 ms` batched `onBatch` updates.
- **`@elv/features` (`live/useLiveNowNext.ts`):** Wire `createShortEpgQueue` for optional Xtream short-EPG lazy fills alongside existing SQLite `queryNowNext` so rapid D-pad scrolling prioritizes currently visible rows.

### 2.7 `und` Track Language Inference & `stretch` Aspect Mode (`#151`)
- **`@elv/playback` (`track-preferences.ts`):** When a track's `language` is missing or `'und'`, infer normalized ISO 639-2 code via `extractLanguageCodeFromLabel(track.label)` from `@elv/domain`.
- **Apple `AetherEngine` (`AetherBackend+Tracks.swift`):** Wire `extractTrackLanguageFromLabel` when `language` is `nil`/empty/`"und"`.
- **`'stretch'` Aspect Mode:** Extend `ResizeMode` / `SurfaceFit` / `VideoSurfaceProps` to `'fit' | 'fill' | 'stretch'` across `packages/features/src/ports/video-host.ts`, `PlayerSettingsSheet`, desktop `PlayerCanvas.tsx` (`objectFit: 'fill'`), Android `SurfaceFit.kt` (`RESIZE_MODE_FILL`) + `ElvEngineMedia3View.kt`, and Apple `SubtitleLayout.swift` + `AetherSurfaceView.swift` (`.resize`).
- **Android Media3 Seamless AFR Gating (`Media3Engine.kt`):** Apply `C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS` when `Build.VERSION.SDK_INT >= 30` (API 30+), falling back safely on API 28–29.

## 3. Verification

- Strict TDD across `@elv/domain`, `@elv/sources`, `@elv/data`, `@elv/playback`, `@elv/features`, `@elv/desktop`, Android Gradle (`:elv-engine-media3:testDebugUnitTest`), and Apple `elv-mac` (`swift test` + Xcode 26.4.1 iOS/tvOS compile).
- `pnpm check` (`11 passed, 0 failed`) + `pnpm gate security` + independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

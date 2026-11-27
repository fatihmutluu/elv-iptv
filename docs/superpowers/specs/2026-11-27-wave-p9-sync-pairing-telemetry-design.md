# Wave P9 Design Spec — Unified Diagnostics Telemetry, Automatic E2EE Sync & Bidirectional X25519 QR Pairing

> **Issues:** `#509` (Unified Diagnostics & Performance Telemetry with First-Run Privacy Consent & Full Runtime Collectors), `#510` (Automatic Background E2EE Sync, Destructive Account Delete, Hidden Sync URL & Single-QR + 8-Digit X25519 Bidirectional Pairing)
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — zero hardcoded hex, zero RN `<Modal>` on TV, strict E2EE zero-knowledge guarantees, zero plaintext credentials/PII in SQLite or telemetry, zero DVR/competitor copy)
> **Date:** 2026-11-27

## 1. Goals & Scope

### 1.1 Unified Diagnostics & Performance Telemetry (`#509`, `[1.6]`)
- Consolidate all diagnostics, crash reporting, and performance telemetry toggles into a **single unified toggle** placed directly above **Reset** at the bottom of `Settings -> Appearance` (removing separate log-inclusion toggles, raw payload preview buttons, and the separate Feedback telemetry card; renaming the Feedback tab cleanly to `Feedback` / `Geri Bildirim`).
- Gate collection behind a first-run privacy & diagnostics consent acknowledgment (`privacyConsentAnswered` + `telemetryOptIn`).
- Expand `@elv/sync`, `apps/sync-server` (D1 migration `0002`), `tools/src/telemetry-digest.ts`, Desktop IPC, and Mobile runtime collectors to support all 13 event kinds (`startup`, `screen_transition`, `frame_jank`, `js_stall`, `memory_pressure`, `playback_start`, `playback_rebuffer`, `playback_error`, `media_decode_failure`, `sqlite_slow_op`, `app_crash`, `unhandled_error`, `catalog_import`) plus a sanitized device technical profile (`osVersion`, `formFactor`, `arch`, `ramBucket`, `gpu`, `resolution`, `locale`).
- Enforce strict PII/path/URL/credential redaction (`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, URLs, credentials, emails, private IPs) before queueing or sending any event.

### 1.2 Account UI Cleanup (`#510`, `[1.42]`, `[1.43]`)
- Add semantic `destructive` variant to `CtaButton` (`@elv/ui-kit`) with high-contrast red tokens across all theme presets and apply it to `Permanently Delete Account` trigger & confirmation buttons.
- Remove the `Sync Server URL` text input (`AccountServerUrlField`) from user-facing Account settings; rely solely on build-time `ELV_SYNC_SERVER_URL` injection across Desktop (`bundle.mjs`) and Mobile (`build-app-config.ts`) without empty preference strings overwriting the baked URL.

### 1.3 Full Automatic Background E2EE Sync (`#510`, `[1.44]`)
- Upgrade `VaultSnapshot` (backward-compatible with `v1` vaults) to capture 100% of user state across profiles:
  - Favorites (`sortOrder` + unfavorite tombstones + `profileId`),
  - Watch progress (both in-progress and completed `watched = 1` items + `profileId`),
  - `watchedEpisodesBitfields` per `(profileId, seriesKey)`,
  - `continueWatchingDismissals`,
  - Collections (`sortOrder`, `profileId`, item removals / folder moves),
  - Sources (`m3u`, `xtream`, and `stalker`, renames, `excludedProfileIds`, `epgShiftMs`, `xmltvTimezone`, `categorySelection`, `transport`, `backupServers`, LWW merge on existing source IDs),
  - Ratings (`profileId`),
  - Profiles + Kids Mode + parental settings + PBKDF2 PIN hashes (`v1:<salt>:<digest>` strictly inside the E2EE encrypted vault blob).
- Wire `createAutoSyncScheduler` in Desktop and Mobile:
  - **Push:** playback pause (`2s` debounce), playback exit / completion / channel switch (immediate), `3 min` viewing heartbeat when dirty, `3s` debounced mutation push (favorites/order, ratings, watched, dismissals, collections, sources/rename/sharing, profiles/Kids Mode/PIN), and bounded final flush on background / minimize-to-tray / quit (before catalog worker closes SQLite).
  - **Pull:** on startup, on foreground resume after `>= 60s` away, and on network reconnect.

### 1.4 Single-QR + 8-Digit Code Bidirectional X25519 Pairing (`#510`, `[1.45]`)
- Implement pure-JS RFC 7748 X25519 ECDH + RFC 5869 HKDF-SHA256 in `@elv/sync` (zero runtime dependencies, Hermes-compatible, verified against official RFC test vectors).
- QR URI (`elviptv://pair?c=<8digits>&pk=<pkA_b64url>` or `https://<host>/pair?c=...&pk=...`, strictly `<= 213` bytes) + manual 8-digit CSPRNG numeric code.
- Enforce server-side IP rate limiting, **3-attempt global lockout**, and 5-minute session TTL (`apps/sync-server` D1 migration `0002`).
- Bind **4-digit SAS** and AES-256-GCM session keys to the canonical transcript (`code || sorted(pkA, pkB)`) via HKDF-SHA256; require explicit SAS confirmation before transferring `{ email, refreshToken, vaultKeyB64 }`.
- Handle all 5 bidirectional cases automatically: `neither_signed_in`, `responder_to_host`, `host_to_responder`, `same_account`, and `different_accounts` (dual consent with privacy-masked emails `a***@domain.com`).
- Wire `elviptv://pair` + Universal Link / App Link deep links on Desktop and Mobile plus a pluggable `QrScannerPort` for mobile camera scanning.

## 2. Verification & Deployment
- Independent whole-branch **`Gemini 4 Neon (XHigh)`** security/crypto/concurrency review before merge.
- Full `pnpm check` (`11 passed, 0 failed`), CI green, squash-merge, then apply D1 migration `0002` and deploy updated `apps/sync-server` live to Cloudflare Workers (`wrangler.prod.toml`) verifying `/health` `200 OK`.

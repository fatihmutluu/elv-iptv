# Wave F9 Design Spec — E2EE Sync Server, Auth & Universal QR Pairing + Opt-In AI Telemetry & Feedback (#26, #458)

- **Date:** 2026-11-25
- **Issues:** Closes #26, Closes #458 (completes Parent Epics #343 and #349)
- **Product Decisions:** #42 (`#26` E2EE Sync, first-run Welcome screen with "Continue without account", email+password+confirm signup, OAuth-ready Apple/Google seam, universal QR pairing `<= 213` bytes, mandatory in-app & web `GET /account-deletion` erasure), #43 (`#458` opt-in strictly redacted telemetry + Media3 decode failure visibility for `#70` + Settings Feedback & Report Issue panel + `pnpm telemetry:digest`).

## 1. Phase 1 Packages & Backend Contracts

### 1.1 Pure Package `@elv/sync` (`packages/sync/`)
- Governed as a pure leaf package in `.dependency-cruiser.cjs` (`PURE` + `leaf-packages-import-domain-only`) and `biome.json` (pure import/global bans). Imports `@elv/domain` only; zero `react`, `react-native`, `expo*`, `electron`, `node:*`, `TextDecoder`, `Blob`, `structuredClone`, or `window`.
- **Crypto & Encoding (`src/encoding.ts`, `src/pure-crypto.ts`, `src/vault-crypto.ts`):**
  - `VaultCryptoPort`: `randomBytes`, `deriveKeyPbkdf2`, `encryptAesGcm`, `decryptAesGcm`, `sha256`.
  - Ships `createPureJsVaultCryptoPort(randomBytes)` (RFC 6070 PBKDF2-HMAC-SHA256, FIPS 180-4 SHA-256, NIST SP 800-38D AES-256-GCM — identical across Hermes, Node, and Workers) and `createWebCryptoVaultPort(subtle, getRandomValues)`.
  - Zero-knowledge derivation:
    - Auth verifier sent to server: `base64url(PBKDF2-SHA256("elv-auth-v1|" + email.trim().toLowerCase(), password, 210_000, 32))`. Raw password and vault KEK NEVER leave the device.
    - Vault KEK: `PBKDF2-SHA256("elv-vault-v1|" + kdfSalt, password, 210_000, 32)` wraps the random 32-byte `vaultKey` with AES-256-GCM.
    - Recovery Code: 24-character base32 string (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`, 120 bits entropy) separately wraps `vaultKey` so users can recover without server knowledge.
    - Vault payload encryption: AES-256-GCM with fresh 12-byte random IV and AAD `elv-vault-blob-v1|${userId}|${revision}`.
- **Tombstone Delta Vault & Watched Bitfield (`src/vault-merge.ts`):**
  - `VaultSnapshot` (`schemaVersion: 1`): encrypted sources (`SyncSourceRecord[]` with credentials), favorites, hidden/pinned channels, custom channel groups, custom VOD collections, watch progress (LWW with tombstone deletion), and compact watched-episode bitfield (`encodeEpisodeBitfield` / `decodeEpisodeBitfield` / `mergeEpisodeBitfields`).
  - `mergeVaultSnapshots(local, remote)` performs deterministic LWW + tombstone resolution.
- **Auth & Universal QR Pairing (`src/auth-client.ts`, `src/qr-pairing.ts`):**
  - `AuthProviderId = 'email-password' | 'apple' | 'google'` with `AuthProviderAdapter` seam (Apple Guideline 4.8 compliant: Phase 1 is email+password only; Sign in with Apple plugs in before any third-party social login).
  - Universal QR pairing payload: `elviptv://pair?c=<code12>&k=<key22>` (optional `&s=<origin>` when custom server), strictly `<= 213` UTF-8 bytes (`MAX_QR_PAYLOAD_BYTES` in `@elv/ui-kit/qr-matrix.ts`).
  - Target device generates ephemeral 16-byte AES-GCM key `k` locally (never sent to server); scanner encrypts `{ email, refreshToken, vaultKeyB64 }` with `k` and posts ciphertext to `/v1/pair/claim`; target polls `/v1/pair/poll/:id` and decrypts locally.
- **Opt-In Runtime Telemetry & Feedback (`src/telemetry.ts`, `src/feedback.ts`):**
  - Event kinds: `'startup' | 'screen_transition' | 'frame_jank' | 'js_stall' | 'memory_pressure' | 'playback_start' | 'playback_rebuffer' | 'playback_error' | 'media_decode_failure' | 'sqlite_slow_op'`.
  - `media_decode_failure` captures strictly allowlisted redacted fields (`engine`, `container`, `videoCodec`, `audioCodec`, `errorCode`, `hdrFormat?`, `isLive`) so real-world Android Media3 gaps for `#70` are visible without any URL, hostname, IP, credential, or title.
  - Strict allowlist sanitizer + `@elv/domain` `redactText()` + URL/IP/credential/path rejection.
  - Bounded FIFO ring buffer (`maxEntries = 256`, `maxBytes = 131_072`), rotating anonymous `sessionId`, zero network calls when `optIn === false`, exponential backoff, and remote kill-switch (`disabled: true`).
  - Feedback categories: `'playback_issue' | 'channel_epg' | 'ui_remote' | 'sync_account' | 'feature_request' | 'other'`; comment bounded `<= 2000` chars + redacted + optional redacted diagnostics summary.

### 1.2 Self-Hostable Sync & Telemetry Backend (`apps/sync-server/`)
- Compatible with **Cloudflare Workers + D1** (`src/worker.ts`, `wrangler.toml`, `migrations/0001_init.sql`, `src/storage-d1.ts`) AND **Node.js HTTP** (`src/node-server.ts`, `src/storage-memory.ts`).
- Endpoints:
  - `GET /health`
  - `GET /account-deletion` (public EN/TR HTML page for Google Play / Microsoft Store compliance)
  - `POST /v1/auth/register`, `POST /v1/auth/login`, `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `DELETE /v1/auth/account` (Apple 5.1.1(v) permanent erasure)
  - `POST /v1/pair/create`, `POST /v1/pair/claim`, `GET /v1/pair/poll/:id` (5-min TTL, single-use atomic consumption)
  - `GET /v1/vault`, `PUT /v1/vault` (optimistic concurrency `expectedRevision` -> `409` on mismatch; opaque ciphertext only)
  - `POST /v1/telemetry`, `POST /v1/feedback`
  - `GET /v1/admin/digest` (constant-time `Bearer <ADMIN_TOKEN>` auth; per-version/platform p50/p95 latencies, stall/jank rates, top `media_decode_failure` codec/container breakdowns, and recent feedback summaries)
- Security: Web Crypto PBKDF2 server-side verifier hashing, constant-time comparisons, HMAC-SHA256 JWT access tokens (15m) + hashed rotating refresh tokens (30d), per-IP sliding-window rate limits, body size caps.

### 1.3 AI-Ready Telemetry Digest CLI (`tools/bin/telemetry-digest.ts`)
- Root script `"telemetry:digest": "node tools/bin/telemetry-digest.ts"`.
- Supports `--url` / `ELV_SYNC_URL` + `ELV_ADMIN_TOKEN` OR `--input <json-file>`, `--format md|json`, producing an AI-analyzable Markdown/JSON summary highlighting slow screens, jank/stall hotspots, Media3 codec/container decode failures (`#70`), and categorized user feedback.

## 2. Phase 2 Domain Preferences, i18n, Cinema Quietude v2 UI & App Wiring
- **`@elv/domain` (`preferences-wave-f9.ts`):** `telemetryOptIn: boolean` (`false`), `welcomeDismissed: boolean` (`false`), `syncServerUrl: string` (`''`).
- **`@elv/i18n` (`en-wave-f9.ts`, `tr-wave-f9.ts`, `.po`):** Complete EN/TR parity across Welcome, Account/Sync, Universal QR Pairing, Delete Account, Opt-In Telemetry Preview, and Feedback & Report Issue.
- **`@elv/features`:**
  - `ports/wave-f9-ports.ts`: `SyncAccountPort`, `TelemetryPort`, `FeedbackPort`.
  - `account/WelcomeSyncOverlay.tsx`: First-run Cinema Quietude v2 Sign In / Create Account / Pair via QR overlay with prominent **"Continue without account"** at bottom (`<= 100%` D-pad/touch/keyboard reachable, zero RN `<Modal>`).
  - `account/AccountSettingsPanel.tsx`: Settings `'account'` section (Sign In/Up, Sync Now, Universal QR Pair Device with live `QrCode`, Recovery Code, Sign Out, mandatory **Delete Account** with confirmation).
  - `feedback/FeedbackSettingsPanel.tsx`: Settings `'feedback'` section (Opt-In Runtime Telemetry toggle + exact JSON payload preview + **Feedback & Report Issue** form with category chips, comment, optional redacted diagnostics toggle).
  - `app-shell-wave-f9.tsx`: Wires Welcome, Account, Feedback, screen-transition latency, and `media_decode_failure` / playback error telemetry without inflating `AppShell.tsx` past 800 lines.
- **App Adapters (`apps/tv-mobile/src/sync/`, `apps/desktop/src/main/sync/` + `apps/desktop/renderer/src/sync/`):** Wire E2EE sync, secure token/key storage, universal QR pairing, opt-in telemetry ring buffer + uploader, and feedback submission into both apps cleanly (100% functional offline/without account).

## 3. Invariants
- Zero prohibited scope copy or third-party competitor brand names.
- Zero telemetry network traffic when `telemetryOptIn === false`.
- Provider URLs, credentials, IPs, file paths, and media titles NEVER enter telemetry payloads or server plaintext.
- QR pairing payload strictly `<= 213` UTF-8 bytes.
- Every file `<= 800` lines; pure packages `>= 90%` line coverage; `pnpm check` `11/11`.

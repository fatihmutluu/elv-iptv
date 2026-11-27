# sync (`@elv/sync`)

Pure zero-knowledge E2EE vault crypto, deterministic tombstone sync merge, auth/QR pairing clients, opt-in redacted telemetry, and feedback sanitization (`#26`, `#458`).

## Commands
- `pnpm --filter @elv/sync typecheck` type-checks this package.
- `pnpm --filter @elv/sync test` runs its Vitest tests with >= 90% line coverage.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: imports `@elv/domain` and itself only; zero `react`, `react-native`, `expo*`, `electron`, `node:*`, or restricted Hermes/browser globals (`TextDecoder`, `window`, `document`, `Blob`, `structuredClone`, `CompressionStream`, `DecompressionStream`, `localStorage`, `navigator`, `location`).
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Raw passwords, vault KEKs, and ephemeral QR keys never leave the device; telemetry is strictly allowlisted, double-redacted, and emits zero network calls unless opted in.
- Tests live beside the code as `*.test.ts`.

## Public surface
- `encoding.ts`: hand-written UTF-8, base64url, hex, and constant-time byte comparison (`constantTimeEqual`).
- `ports.ts`: `VaultCryptoPort`, `SyncHttpPort`, `SyncHttpResponse`, `SyncClockPort`.
- `pure-crypto.ts`: pure-TS SHA-256, HMAC-SHA256, PBKDF2-SHA256, AES-256-GCM (`createPureJsVaultCryptoPort`) plus `createWebCryptoVaultPort`.
- `x25519.ts`: pure-TS constant-time RFC 7748 Curve25519 X25519 (16-limb `Float64Array` GF(2^255-19) with low-order point rejection) and RFC 5869 HKDF-SHA256 (`hkdfExtract`, `hkdfExpand`, `hkdfSha256`).
- `vault-crypto.ts` & `vault-validate.ts`: zero-knowledge auth verifier, vault key bundle + 24-char recovery code, password/recovery unlock, AAD-bound snapshot encryption/decryption, and strict v1->v2 upgrade & validation.
- `vault-merge.ts`: `VaultSnapshot` (`schemaVersion: 2`), per-profile flags/progress/bitfields/dismissals/collections/ratings, stalker + source settings, encrypted profiles, and deterministic LWW + tombstone `mergeVaultSnapshots`.
- `auth-client.ts`: `AuthProviderId`, `AuthProviderAdapter` seam, `validateSignupInput`, and `createSyncAuthClient`.
- `qr-pairing.ts` & `pairing-v2.ts`: `MAX_SYNC_QR_BYTES` (213), bidirectional 8-digit X25519 QR/code pairing (`encodeBidirectionalPairingQr`, `parsePairingQrOrCode`, `derivePairingSessionKeys`, `encryptPairingTransfer`, `decryptPairingTransfer`, `resolvePairingDirection`, `maskEmail`), plus legacy `buildPairingQrUri`/`parsePairingQrUri`/`createQrPairingClient`.
- `telemetry.ts` & `telemetry-redact.ts`: 13 allowlisted `TelemetryEvent` kinds (including `media_decode_failure`, `app_crash`, `unhandled_error`, `catalog_import`), `DeviceTechnicalProfile`, `redactDiagnosticText`, double-redacted `sanitizeTelemetryEvent`, bounded ring buffer queue, opt-in uploader with backoff & remote kill-switch, and payload preview.
- `auto-sync-scheduler.ts`: platform-agnostic `createAutoSyncScheduler` with single-flight queue, mutation/pause debouncing, viewing heartbeat, startup/foreground/reconnect pulls, bounded background flush, and capped exponential backoff retry.
- `feedback.ts`: `FEEDBACK_CATEGORIES`, `sanitizeFeedbackSubmission`, and `submitFeedback`.

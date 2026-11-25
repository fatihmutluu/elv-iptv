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
- `vault-crypto.ts`: zero-knowledge auth verifier, vault key bundle + 24-char recovery code, password/recovery unlock, and AAD-bound snapshot encryption/decryption.
- `vault-merge.ts`: `VaultSnapshot` (`schemaVersion: 1`), compact episode watched bitfields, and deterministic LWW + tombstone `mergeVaultSnapshots`.
- `auth-client.ts`: `AuthProviderId`, `AuthProviderAdapter` seam, `validateSignupInput`, and `createSyncAuthClient`.
- `qr-pairing.ts`: `MAX_SYNC_QR_BYTES` (213), `buildPairingQrUri`/`parsePairingQrUri`, and E2EE `createQrPairingClient`.
- `telemetry.ts`: allowlisted `TelemetryEvent` union (including `media_decode_failure` for `#70`), double-redacted `sanitizeTelemetryEvent`, bounded ring buffer queue, opt-in uploader with backoff & remote kill-switch, and payload preview.
- `feedback.ts`: `FEEDBACK_CATEGORIES`, `sanitizeFeedbackSubmission`, and `submitFeedback`.

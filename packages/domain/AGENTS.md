# domain (`@elv/domain`)

Models, ids, Result/errors, clock, logging and the ports (storage, sql, http, keys, secure store).

## Commands
- `pnpm --filter @elv/domain typecheck` type-checks this package.
- `pnpm --filter @elv/domain test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: none.
- Tests live beside the code as `*.test.ts`.

## Public surface (scanners round)
- `Result`, `ElvError`, `ok`, `err`, `elvError` in `result.ts`; error details never carry credentials.
- `HttpClient`, `FetchLike`, `createFetchHttpClient`, `httpStatusError`, `Decompressor` in `http.ts` (port plus a fetch adapter); initial URLs and non-empty `res.url` values are validated as HTTP(S) (`res.url` propagates into `finalUrl` and redirect resolution), outbound headers are sanitized via `sanitizeHeaders`, and requests follow up to 10 redirects manually (`redirect: 'manual'`, failing with `network/too-many-redirects` on loops) while stripping credential headers (`Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `X-Auth-Token`) on cross-origin hops. `2xx` and `304` resolve `ok`, while other non-2xx statuses map to `auth/http-401|403` or `network/http-<status>` (`httpStatusError`). Callers must iterate or discard every body (`.return()` cancels the underlying `ReadableStream` and detaches caller abort listeners even before `.next()`); a pre-response connection-reset error (`ECONNRESET`, `EPIPE`, `UND_ERR_SOCKET`, "other side closed") is retried once; silent bodies end with `network`/`timeout` after `idleTimeoutMs` (default 30 s) and aborts with `network`/`aborted`.
- `SqlDriver`, `SqlValue`, `SecretStore`, `Scheduler` in `sql.ts` (catalog import ports). `SqlDriver` serializes calls and exposes optional `close?()`:
  inside `transaction(fn)` use only the `tx` it receives (awaiting the outer driver there never resolves); `tx.batch`
  joins the open transaction; transactions do not nest. `SecretStore` keys use only letters, digits, `.`, `-`, `_`.
  `Scheduler.yieldNow()` must yield a macrotask (timer, `setImmediate`, frame), never just a resolved promise.
- `isAsyncIterable`, `openAsyncIterator` in `async-iterable.ts`: resolve `[Symbol.asyncIterator]` first and fall back to Babel's `'@@asyncIterator'` method (with receiver preserved) when `Symbol.asyncIterator` is `undefined` in Hermes.
- `SourceKind`, `ContentKind`, `TransportSettings`, `transportHeaders` in `source.ts`.
- `sanitizeHeaderName`, `sanitizeHeaderValue`, `sanitizeHeaders`, `setSafeHeader`, `originOf`, `sameOrigin`, `hasCredentialHeaders`, `scopeCredentialHeaders` in `headers.ts`: RFC 7230 token validation, control-character stripping (`0x00–0x1F`, `0x7F`), prototype-safe header writes, pure RFC 3986 origin normalization, and exact-origin scoping for `Authorization`, `Proxy-Authorization`, `Cookie`, `X-Api-Key`, and `X-Auth-Token`.
- `redactUrl`, `redactText` in `redact.ts`: strict allowlist URL and credential redaction (`http(s)`, `rtsp(s)`, `rtmp(s)`, `tcp`, `tls`, `httpproxy`, `udp`, `rtp`, `ftp`, `file` -> `file://<redacted>`, sensitive headers, `Bearer`/`Basic`, and all `CREDENTIAL_PARAMS`).
- `normalizeLanguageCode`, `sameLanguageCode` in `languages.ts`: canonical ISO 639-1 / ISO 639-2(T/B) / BCP-47 primary-subtag normalization.
- `PlaybackGuard`, `GuardedPlaybackSession`, `noopPlaybackGuard`, `createPlaybackGuard` in `playback-guard.ts`: synchronous playback teardown port on source removal.
- `PreferencesSnapshot`, `PreferencesPatch`, `BufferPreset`, `BUFFER_PRESETS`, `PreferencesKvBackend`, `PreferencesStore`, `DEFAULT_PREFERENCES`, `PREFERENCES_SCHEMA_VERSION`, `MAX_PREFERENCES_BYTES` (4096 B, tvOS-500KB-safe), `MIN_PREF_FONT_SCALE` (0.9), `MAX_PREF_FONT_SCALE` (1.2), `parsePreferences`, `serializePreferences`, `createMemoryPreferencesStore`, `createKvPreferencesStore` in `preferences.ts`: resilient preferences codec (v1 backward-compatible `bufferPreset`, `useTextureView`, `subtitleStyle`, `#147`, `#262`, `#32`) and promise-queue-serialized KV/memory stores with subscriber isolation.
- `SubtitleStyleConfig`, `DEFAULT_SUBTITLE_STYLE`, `SUBTITLE_*` presets/guards, `normalizeSubtitleStyle`, `mergeSubtitleStyle`, `subtitleStyleEquals` in `subtitle-style.ts`: cross-platform subtitle appearance preferences (`#32`), omitted from serialized JSON when equal to defaults.
- `ACTIVE_PROFILE_PREF_KEY`, `PROFILE_ID_RE`, `profilePreferencesKey`, `ProfilePreferencesManager`, `ProfilePreferencesManagerOptions`, `ProfilePreferencesTimers`, `createProfilePreferencesManager` in `profile-preferences.ts`: per-profile KV preferences manager with `'default'` v1 key compatibility, atomic zero-blink `switchProfile` flush + hydrate, and non-default profile cleanup (`#15`).
- `normalizeStreamUrl`, `xtreamKey`, `m3uKey` in `content-key.ts`: credential-free catalog identity that keeps distinct streams apart (ADR 0011).
- The tsconfig adds the `DOM` lib for `AbortController`, timers and `Response` types only; no runtime DOM use.

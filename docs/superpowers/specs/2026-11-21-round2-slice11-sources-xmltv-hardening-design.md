# Round 2 Slice 11 — Sources, M3U, XMLTV & Xtream Real-World Ingestion Hardening

## 1. Objective
Close five `priority:high` real-world ingestion, decompression, and EPG reliability issues (`#169`, `#173`, `#174`, `#305`, `#329`) across `@elv/sources`, `@elv/data`, and `apps/desktop` while keeping bounded O(1) streaming memory, zero UI-thread stalls, and strict pure-package boundaries.

## 2. Deliverables & Contracts

### 2.1 Shared Gzip Sniffing, Bomb Ceiling, Concatenated `.gz` & XMLTV Salvage (`#169`, `#174`)
- **`packages/sources/src/gzip-stream.ts` (pure TypeScript, zero `node:*` imports):**
  - Export `DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024` (256 MiB) and `decodeMaybeGzip(chunks, { decompressor?, maxDecompressedBytes? }): AsyncGenerator<Uint8Array, Result<void>>`.
  - Peeks the first 2 bytes (`0x1f 0x8b`) regardless of HTTP `Content-Encoding` headers:
    - Non-gzip streams pass through directly with zero extra copies.
    - Gzip without a `decompressor` closes the upstream iterator and returns `err(elvError('source-format', 'gzip-unsupported'))`.
    - Gzip with a `decompressor` enforces a streaming decompressed byte ceiling (`maxDecompressedBytes`), immediately closing both the decompressor and upstream iterator and returning `err(elvError('source-format', 'too-large'))` on overflow.
    - Supports **multi-member concatenated `.gz`** streams in bounded O(1) memory (`<= 64 KiB` compressed sliding window + streaming IEEE CRC32 & ISIZE) so both native multi-member decompressors (Node `zlib.createGunzip()`) and single-member Web `DecompressionStream('gzip')` decode all members completely without silent truncation or trailing-junk crashes.
    - Preserves upstream `sourceError` precedence over `gzip-corrupt`.
- **`packages/sources/src/xmltv.ts`, `xmltv-types.ts`, `xml-tokens.ts`, `xmltv-children.ts`:**
  - Route `scanXmltv` through `decodeMaybeGzip` with `opts.maxDecompressedBytes` (`DEFAULT_MAX_DECOMPRESSED_BYTES`).
  - Structural salvage: treat stray unescaped `<` (not followed by `[A-Za-z_:]`, `/`, `!`, `?`) as literal text in `readText` and non-fatal in `parseChildren`; preserve bare `&` in text/attributes; salvage all complete `<channel>` and `<programme>` blocks around malformed markup and truncated tails while preserving all existing error/skip warnings.
- **`packages/data/src/import-guide.ts` & `packages/data/src/import-m3u.ts`:**
  - Raise full-import response-header timeout `REQUEST_TIMEOUT_MS` to `180_000` ms (3 minutes) while keeping tight playback/API timeouts untouched.
  - Pass `decompressor: c.deps.decompressor` into both `scanXmltv` and `scanM3u`.
- **`apps/desktop/src/utility/catalog-worker.ts` & `catalog-worker-runtime.ts`:**
  - Wire an optional `decompressor?: Decompressor` into `CatalogWorkerRuntimeDeps` and provide a streaming Node `zlib.createGunzip()` decompressor from `catalog-worker.ts` so desktop `.xml.gz` and gzipped M3U imports work natively.

### 2.2 M3U Inline Base64 Logo Survival, Concatenated `url-tvg` & Backup URLs (`#169`, `#173`)
- **`packages/sources/src/m3u.ts`, `m3u-attrs.ts`, `m3u-types.ts`:**
  - Survive oversized inline `data:image/...` base64 `tvg-logo` / `logo` attributes (even multi-megabyte values exceeding `MAX_LINE` = 1 MiB) without dropping the channel entry: stream-strip oversized `data:` logo attribute values in O(1) memory before `MAX_LINE` triggers `tooLong()`, cap inline `data:` logos at `4096` bytes (`MAX_INLINE_LOGO_BYTES`), omit `tvgLogo` when stripped, and emit a non-fatal warning (`inline-logo-stripped`).
  - Wire `scanM3u` options `{ batchSize?, baseUrl?, decompressor?, maxDecompressedBytes? }` through `decodeMaybeGzip` so gzipped M3U playlists (`0x1f 0x8b`) decompress transparently with bomb protection.
- **`packages/sources/src/m3u-url.ts` & `m3u-types.ts`:**
  - Extend `splitGuideUrls` to split `.xml/http` and `.gz/http` (and `;`) boundaries in addition to `,`, whitespace, and `.xmlhttp`/`.gzhttp`.
  - Split inline `#http://`, `#https://`, `#rtmp://`, `#rtmps://`, `#rtsp://`, `#rtsps://` backup URLs on entry URL lines into `M3uEntry.backupUrls?: string[]` (resolving relative URLs / launcher prefixes / pipe headers cleanly while preserving normal URL fragments like `#chapter1` or `#t=10` on `e.url`).

### 2.3 Xtream Account-Scoped `429` Cooldown, Mirror Failover, EPG Datetime Fallback & Codepages (`#173`, `#305`, `#329`)
- **`packages/sources/src/codepages.ts` (new pure helper) & `packages/sources/src/xtream-records.ts`:**
  - Pure single-byte tables for `windows-1256` (Arabic), `iso-8859-6` (Arabic), `windows-1254` (Turkish), and `windows-1252` (Western Latin).
  - In `fromBase64(value, serverTimezone?)`, when UTF-8 decoding yields `\ufffd`, decode via single-byte codepage fallback (selecting Arabic / Turkish / Latin via byte-range heuristics + optional timezone hint, while still falling back to raw text on control-byte binary garbage).
- **`packages/sources/src/xtream-records.ts` & `packages/sources/src/xtream.ts` (`#305`):**
  - Extend `toEpg(raw, serverTimezone?)` to parse `YYYY-MM-DD HH:mm:ss` (and ISO `YYYY-MM-DDTHH:mm:ss[Z|±HH:MM]`) `start` / `end` (or `stop`) datetime strings into epoch ms using IANA `serverTimezone` (`Intl.DateTimeFormat` with DST support, UTC fallback when absent/invalid) whenever numeric `start_timestamp` / `stop_timestamp` are absent.
  - `createXtreamClient` caches `serverTimezone` from `account()` (and accepts optional `XtreamClientOptions.serverTimezone`) and passes it into `shortEpg()` -> `toEpg()`.
- **`packages/sources/src/xtream-json.ts`, `xtream.ts`, `xtream-types.ts` (`#173`):**
  - Add optional `backupServers?: readonly string[]`, `primaryCooldownMs?: number`, `cooldown429Ms?: number`, and `serverTimezone?: string` to `XtreamClientOptions`.
  - Track account-scoped `429` cooldowns per `HttpClient` (keyed by credentials, never logged or exposed in errors) honoring `Retry-After` headers (seconds or HTTP-date) or default cooldown; while active, fail fast with `network/http-429` without retrying mirrors.
  - On network or 5xx failures (never on `429` or `401`/`403` auth errors), fail over across ordered `[primary, ...backupServers]`, stick to the healthy active server for subsequent calls + `playlistUrl`/`guideUrl`/`streamUrl`, and probe/promote back to primary after `primaryCooldownMs`.

## 3. Verification Plan
- Strict TDD (`RED -> Verify RED -> GREEN -> Verify GREEN`) with `>= 90%` line coverage on `@elv/sources` and `@elv/data`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2 passed`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

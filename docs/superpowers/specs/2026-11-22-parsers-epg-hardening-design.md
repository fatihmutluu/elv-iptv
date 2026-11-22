# Parsers, M3U/XMLTV Persistence, EPG Hardening & Canonical Failover Spec

**Date:** 2026-11-22  
**Issues:** `#428`, `#429`, `#430`, `#431`, `#121`, `#287`  
**Packages:** `@elv/sources`, `@elv/data`, `@elv/playback`  
**Status:** Accepted

## 1. Goals

Close six coupled source-parsing, catalog-persistence, XMLTV/EPG matching, and playback failover reliability issues in one cohesive hardening wave without regressing zero-credential SQLite invariants or bounded-memory streaming budgets:

1. **M3U / XMLTV / Xtream parser safety (`#428`):**
   - Return trimmed `tvg-id` / `channel-id` values from M3U `#EXTINF:` and trimmed `<channel id>` / `<programme channel>` values from XMLTV so exact map lookups never silently fail on leading/trailing spaces.
   - Gate all artwork URLs (`tvg-logo` / `logo`, XMLTV `<icon src>`, Xtream `stream_icon` / `cover`) through a single scheme validator (`sanitizeArtworkUrl`) allowing only `http://`, `https://`, and bounded (`<= 4096` bytes) non-SVG `data:image/*` URIs (blocking `file:`, `javascript:`, `ftp:`, `content:`, `data:image/svg+xml`, `data:text/html`, protocol-relative, and schemeless/relative strings).
   - Handle backslash-escaped quotes (`\"`, `\'`, `\\`) and malformed unescaped inner quotes cleanly inside `#EXTINF:` attribute parsing (`parseAttrs`) without dropping subsequent attributes or mangling channel names containing commas.
   - Restrict Sat>IP leading numeric prefix stripping (`"84. Das Erste HD" -> chno: 84, name: "Das Erste HD"`) to live entries (`kindHint === 'live'`) after `finishEntry` determines `kindHint`, preserving movie/VOD titles such as `"2001. A Space Odyssey"` as well as numeric channel names (`"24 TV"`, `"360 TV"`, `"100.5 FM"`).

2. **XMLTV encoding, timezones, ustar wrapper & multi-language preference (`#429`, `#121`):**
   - Wire `normalizeBomChunks` (UTF-8 / UTF-16LE / UTF-16BE / UTF-32LE / UTF-32BE) into `scanXmltv` and strip leading 512-byte POSIX `ustar` tar headers (magic `"ustar"` at byte offset 257) before scanning XML elements.
   - Support declared `<?xml encoding="..."?>` single-byte codepages (`windows-1252` / `iso-8859-1`, `windows-1254` / `iso-8859-9`, `windows-1251`, `windows-1256`, `iso-8859-6`) using shared WHATWG tables in `codepages.ts` instead of emitting `U+FFFD`.
   - Accept named `UTC` and `GMT` timezone suffixes (including `UTC±HHMM` / `GMT±HH:MM`) in `parseXmltvTime`.
   - Support optional `preferredLanguages?: readonly string[]` in `XmltvOptions` so `<title lang>`, `<sub-title lang>`, and `<desc lang>` select by strict precedence: exact BCP-47 tag -> primary language subtag (including common ISO-639-2/B/T aliases) -> untagged -> first seen.

3. **M3U import persistence & sharded secret storage (`#430`, `#121`):**
   - **Schema Migration v6 (`schema-v6.ts`):** Add `backup_urls_json TEXT` to `live`, `live_next`, `movies`, `movies_next`, `episodes`, `episodes_next`, and `epg_shift_ms INTEGER` to `live` and `live_next` (updating `EXPECTED_TABLE_COLUMNS` for drift self-healing).
   - Persist credential-free templated `M3uEntry.backupUrls` into `backup_urls_json` (judging backup hosts via `RuleBook` alongside primary streams) and expose resolved `alternates?: readonly { url: string; headers: Record<string, string> }[]` on `@elv/data` `StreamRequest` (skipping unresolvable backup entries without failing the primary stream).
   - Persist `M3uEntry.shiftHours` (`tvg-shift`) into `live.epg_shift_ms` and support optional source-level `SourceSettings.epgShiftMs`, applying `(live.epg_shift_ms ?? 0) + (source.settings.epgShiftMs ?? 0)` at EPG query time (`queryNowNext`, `queryEpgWindow`) so channels sharing one `guide_id` can carry distinct shifts without duplicating programme rows.
   - Replace the hard 64 KiB `urlvars` failure with bounded chunked sharding (`urlvars-store.ts`): entries `<= 60_000` bytes remain single-key `source.<id>.urlvars`; larger maps shard across `source.<id>.urlvars.0..N-1` with manifest `{"__chunks": N}` in `source.<id>.urlvars` up to a safe ceiling (`MAX_URLVARS_CHUNKS = 256`, failing closed with `source-format/urlvars-too-large` only above the ceiling). `readUrlVars`, rollback, post-commit shrink, and `removeSecrets` handle all shards cleanly.
   - Remove the single-logo host rule bypass in `RuleBook.judgeBuckets` (`m3u-rules.ts`) so a single tokenized logo URL on a multi-stream host is never written unredacted to SQLite.
   - Template `entry.headers.userAgent` into `VarBook` (`{{h:user-agent}}`) and resolve it in `stream-resolver.ts` (preserving backwards compatibility with legacy literal `headers_json.userAgent` rows).

4. **EPG import resilience, channel matching & non-overlapping schedules (`#431`, `#121`):**
   - Add up to 2 short jittered retries per XMLTV candidate URL on transient HTTP 5xx / 408 / network / timeout failures in `import-guide.ts`, never retrying `401`, `403`, `404`, `429`, `509`, or caller `aborted`.
   - Decouple `<programme>` staging from `<channel>` arrival order by removing `programmeChannels` filtering during scan (relying on `commitGuide`'s mapped-channel filter into `programmes` and `programmes_next` cleanup), and merge duplicate `<channel id>` blocks additively (combining unique `display-name` values and filling missing `icon`) without wiping matched channel mappings.
   - Expand `guide-match.ts` precedence to:
     1. Exact `guide_id`
     2. Case-insensitive `guide_id` (`#121`)
     3. `@feedId`-stripped base `guide_id` (case-insensitive) with deterministic regional `@feedId` disambiguation (preferring a feed token present in the live channel name, else lexicographically smallest `guide_id`)
     4. Exact folded display name
     5. Normalized display name
     6. Unique positive finite channel number (supporting decimal sub-channel numbers such as `4.1` and `10.2`)
   - Update `queryChannelByNumber` (`guide-queries.ts`) to accept finite non-negative numbers (including decimals like `4.1`) with deterministic tie-breaking (`favorites` first, then lowest visible category `position`, then `live.id`) while keeping `SEARCH live USING INDEX idx_live_num`.
   - Normalize staged per-channel programmes in strictly ascending `start` order before swapping into `programmes` so out-of-order and overlapping intervals become strictly half-open `[start_i, stop_i)` with `start_i < stop_i <= start_{i+1}`.

5. **Post-redirect canonical failover deduplication (`#287`):**
   - Add optional `finalUrl?: string` and `alternates?: readonly StreamRequest[]` to `@elv/playback` `StreamRequest` and optional `finalUrl?: string` to `EngineError`.
   - Fix Rung-4 alternate iteration in `packages/playback/src/ladder.ts` so all alternates (`TuneRequest.alternates` followed by inline `StreamRequest.alternates`) are traversed across Rung-4 escalations instead of terminating after `alternates[0]`.
   - Track per-tune `failedCanonicalUrls: Set<string>` normalized via `normalizeStreamUrl` from `@elv/domain` (recording each failed stream's `url`, `finalUrl`, and `error.finalUrl`) and skip any alternate whose `url` or `finalUrl` matches an already-failed canonical endpoint before dispatching `engine.load`.

## 2. Invariants & Verification

- Pure packages (`@elv/sources`, `@elv/data`, `@elv/playback`) retain zero forbidden runtime imports and `>= 90%` line coverage.
- Zero credentials, raw secret headers, or unredacted tokenized URLs enter SQLite (`catalog.db`).
- All SQLite EPG/channel-number queries preserve index-backed `EXPLAIN QUERY PLAN` with zero full-table scans.
- `pnpm check` passes with `0 failed`.

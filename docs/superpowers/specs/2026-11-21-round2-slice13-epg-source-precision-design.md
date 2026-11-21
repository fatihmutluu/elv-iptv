# Round 2 Slice 13 — EPG Metadata Precision, Guide Matching, Multicast Normalization & Xtream Format Auto-Probe

## 1. Objective
Close five high-impact EPG, M3U, and Xtream source precision issues (`#170`, `#175`, `#181`, `#267`, `#330`) across `@elv/sources`, `@elv/data`, `@elv/i18n`, and `@elv/features` with strict TDD, bounded streaming memory, and zero UI jank.

## 2. Deliverables & Contracts

### 2.1 XMLTV Metadata Flags, Superscripts, Episode-Num Validation, Latin-1 Prolog, Multicast & Xtream Format Probe (`#170`, `#175`, `#181`, `#267`, `#330`)
- **`packages/sources/src/xmltv-types.ts`, `xmltv-children.ts`, `xmltv.ts`, `xml-tokens.ts`:**
  - Extract `<live/>`, `<new/>`, and `<previously-shown/>` onto `XmltvProgramme` (`isLive?: boolean`, `isNew?: boolean`, `previouslyShown?: boolean`).
  - Strip inline Unicode superscript markers (`U+02B0–U+02FF`, `U+1D00–U+1DBF`, plus superscript Latin letters/digits such as `ᴸᴵⱽᴱ` / `ᴺᴱᵂ`) from `<title>` cleanly, promoting recognized `LIVE`/`NEW` superscript tokens into `isLive` / `isNew` flags before title indexing!
  - Support `<episode-num system="...">` precedence (`xmltv_ns` > `onscreen` > `dd_progid` > other) with `xmltv_ns` validation rejecting alphabetic IDs (`EP012345.0001`, `tt12345.0`), plus fallback extracting leading `S##E##` from `<desc>` when no valid `<episode-num>` was present.
  - Strip stray inline HTML markup (`<b>`, `<i>`, `<em>`, `<br/>`, `<span ...>`, etc.) from `<title>` and `<sub-title>` while preserving legitimate stray `<` text (like `Age < 18`).
  - Respect `encoding="ISO-8859-1"` / `Windows-1252` / `Latin1` declared in the XML prolog (`<?xml version="1.0" encoding="ISO-8859-1"?>`) when decoding XMLTV bytes so accented Latin-1 characters decode cleanly without mojibake.
- **`packages/sources/src/m3u-url.ts` (`#267`):**
  - Normalize leading-`@` multicast URLs `udp://@host:port` -> `udp://host:port` and `rtp://@host:port` -> `rtp://host:port` (case-insensitive scheme, preserving path/query).
- **`packages/sources/src/xtream-probe.ts` & `packages/sources/src/index.ts` (`#330`):**
  - Export `probeXtreamLiveFormat({ http, client, streamIds, headers?, signal?, budgetMs?, now? }): Promise<'ts' | 'm3u8' | undefined>` probing up to 2 live stream IDs within a bounded total budget (default `15_000 ms`, reading at most 512 bytes per probe and immediately closing every response body via `openAsyncIterator(body).return?.()` so zero connections linger), detecting `#EXTM3U`/`#EXT-X-` (`m3u8`) vs MPEG-TS `0x47` sync cadence at `188`/`192`/`204`-byte strides (`ts`).

### 2.2 `@feedId` & Call-Sign EPG Matching, Overlap Clamping, Local-Day Bucketing, Multicast Resolver & Account Meta (`#170`, `#175`, `#181`, `#267`)
- **`packages/data/src/guide-match.ts` (`#181`, `#267`):**
  - Add `@feedId` sub-feed suffix fallback (`Channel.uk@East` -> `Channel.uk`) strictly below exact `guide.id` match and above name/num matching.
  - Add broadcast call-sign preserving normalized name matching (`normalizeGuideChannelName`): preserves 3–5 uppercase letter call signs in parentheses `(XELV)` while stripping `[...]` / `(...)` quality/region noise (`[HD]`, `(East)`, `(West)`) and extraneous broadcast tokens (`24/7`, `east`, `west`, `1080p`, `720p`, `480p`), strictly below exact folded name match and above numeric fallback!
- **`packages/data/src/import-guide.ts` (`#181`):**
  - Deterministically clamp overlapping or duplicate `(channel, start)` programme blocks in `closeOpenProgrammes` (tracking per-channel latest committed block so overlaps clamp `prev.stop = next.start` and duplicate `(channel, start)` blocks keep one clean non-overlapping entry).
- **`packages/data/src/guide-queries.ts` (`#175`):**
  - Explicitly preserve falsy string IDs (`"0"` for `source_id` / `guide_id`), keep every programme query scoped explicitly to `source_id`, and export `bucketProgrammesByLocalDay(programmes, timeZone?)` bucketing epoch-ms timestamps into local calendar day keys (`YYYY-MM-DD`) via `Intl.DateTimeFormat` / local Date (never `HH:mm` string comparison).
- **`packages/data/src/stream-resolver.ts` (`#267`):**
  - Normalize `udp://@host:port` / `rtp://@host:port` -> `udp://host:port` / `rtp://host:port` on resolved stream URLs.
- **`packages/data/src/sources.ts` & `import-xtream.ts` (`#170`):**
  - Persist non-secret `accountMeta: { isTrial, expiresAt }` on `SourceSettings` during Xtream catalog import.

### 2.3 Cinema Quietude Source Trial / Expiring-Soon Warning Badge (`#170`)
- **`packages/i18n/` (EN + TR `.ts` & `.po` catalogs):**
  - Add `sources.badge.trial`, `sources.badge.expiringSoon` (`Expires in {days}d` / `{days} gün içinde doluyor`), and `sources.badge.expired` (`Expired` / `Süresi doldu`).
- **`packages/features/src/sources/account-warning.ts` & `SourcesScreenParts.tsx` / `SourcesScreen.tsx`:**
  - Pure `resolveSourceAccountWarning(accountMeta, nowMs)` returning `'expired' | { kind: 'expiring-soon'; days: number } | 'trial' | null` (7-day warning threshold `7 * 86_400_000` ms).
  - Render subtle Cinema Quietude `MicroPill` warning badge (`testID="source-account-warning-${source.id}"`) on source cards using 100% theme tokens (zero hardcoded hex colors).

## 3. Verification Plan
- Strict TDD (`RED -> Verify RED -> GREEN -> Verify GREEN`) with `>= 90%` line coverage on `@elv/sources` and `@elv/data`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2 passed`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

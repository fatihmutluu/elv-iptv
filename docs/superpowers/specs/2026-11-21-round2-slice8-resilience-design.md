# Round 2 Slice 8 — Startup Orphaned-Run Reaping, Unambiguous EPG Number Matching, Live Clean-End Reconnect & 5s Live-Edge Stability

## 1. Objective
Close four high-impact storage, EPG, and playback stability issues (`#146`, `#148`, `#284`, `#290`) in pure TypeScript across `@elv/data` and `@elv/playback`, protecting all platforms (`Android TV`, `Fire OS`, `tvOS`, `iOS`, `Android`, `Windows`, `macOS`, `Linux`) against stuck post-crash imports, unmapped numeric EPG channels, silent live MPEG-TS disconnects, and flickering live-edge indicators.

## 2. Deliverables & Invariants

### 2.1 Startup Orphaned-Run Reaping & Modest WAL Batching (`#146`, `@elv/data`)
- **`reapOrphanedRuns(db, now)` (`packages/data/src/runs.ts`):**
  - Runs inside a single SQLite transaction on `openCatalog()` startup (after schema migrations succeed):
    - Marks any leftover `import_runs` row with `status = 'running'` as `status = 'failed'`, `finished_at = now`, `error_category = 'storage'`, `error_code = 'interrupted'`.
    - Purges any leftover staged rows in `programmes_next`.
    - Returns `{ reapedRuns, purgedProgrammes }`.
  - Prevents a crash or killed worker mid-import from permanently deadlocking subsequent refreshes with `storage/import-in-progress`.
- **Modest WAL batch size (`packages/data/src/import-types.ts`):**
  - Lower `DEFAULT_BATCH_SIZE` from `500` to `200` (within the `100–250` row sweet spot), keeping write transactions short while existing scheduler yields run between batches.

### 2.2 Unambiguous Channel-Number (`num`) XMLTV Fallback (`#290`, `@elv/data`)
- **`packages/data/src/guide-match.ts`, `guide-commit.ts`, `import-guide.ts`:**
  - Extend `ChannelIndex` with `byNum: Map<number, string[]>` populated from `live.num` (positive finite integers) during `importGuide`.
  - Preserve strict 3-tier matching precedence: **`byId` > `byFold` > unique `byNum`**.
  - Extract unambiguous integer channel numbers from XMLTV `<channel>` display names (e.g. exact numeric `<display-name>101</display-name>` or leading channel-number token like `101 ...` / `#101 ...`) ONLY when all extracted candidates agree on a single channel key in `index.byNum` whose bucket has length `1` (never colliding when multiple channels share a number).
  - Extend `resolveMappings(byId, byName, byNum)` so `byId` wins over `byName`, and `byName` wins over `byNum`, and a `byNum` mapping commits only if exactly one guide channel claims that live channel.

### 2.3 Single-Attempt Live Clean-End Reconnect & Frame-Silence Reset (`#148`, `@elv/playback`)
- **`packages/playback/src/recovery.ts`, `service-events.ts`, `service.ts`, `stall-watchdog.ts`:**
  - When a `live` stream unexpectedly emits `state: 'ended'` after tuning (e.g., upstream MPEG-TS HTTP proxy closes cleanly without an HTTP error), intercept the first unexpected `ended` per tune (`liveCleanEndRetried = false -> true`), keep status transitioning cleanly into a single bounded reconnect (`tuning` + `reload()` + `armStartTimeout`), and NEVER loop infinitely if the reconnect also emits `ended` (second `ended` transitions cleanly to `{ kind: 'ended' }` as normal).
  - VOD `ended` behavior remains 100% unchanged (ends immediately, never auto-reloads).
  - Track monotonic playback progress before first frame / during live playback so `stall-watchdog` cleanly detects a frozen live clock (frame-silence / stalled live anchor advancing `0 ms` while playing beyond `liveStallWindowMs`) and performs a bounded live-edge reset before escalating recovery.

### 2.4 5-Second Live-Edge Grace Window (`#284`, `@elv/playback`)
- **`packages/playback/src/clock.ts`, `types.ts`, `state-store.ts`, `service-events.ts`, `service.ts`, `index.ts`:**
  - Export `LIVE_EDGE_TOLERANCE_MS = 5_000` and pure `isAtLiveEdge(anchor: ClockAnchor | undefined, nowMs: number, toleranceMs = LIVE_EDGE_TOLERANCE_MS): boolean`:
    - Returns `true` when `anchor` is defined and either `anchor.liveEdgeMs === undefined` (live stream without seekable window edge) OR `anchor.liveEdgeMs - positionAt(anchor, nowMs) <= toleranceMs` (with finite/non-negative clamping).
    - Returns `false` when `anchor === undefined` or behind the live edge by more than `toleranceMs`.
  - Add optional `atLiveEdge?: boolean` on `PlaybackState`, kept in sync on live clock/anchor updates and gated by `samePlaybackState` in `state-store.ts` so UI live badges stay rock-steady with zero redundant renders.

## 3. Verification Plan
- Strict TDD across `@elv/data` and `@elv/playback` (`>= 95%` coverage on modified/new modules).
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle hygiene (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` + `catalog.spec.ts`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

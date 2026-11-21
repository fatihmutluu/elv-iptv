# playback (`@elv/playback`)

PlayerEngine contract, PlaybackService, recovery ladder and FakePlayerEngine.

## Commands
- `pnpm --filter @elv/playback typecheck` / `test` (or `pnpm -w check` for every repository check).

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports (ports live in `@elv/domain`).
- Source-first (`src/index.ts`, `./testing` -> `src/testing/index.ts`); allowed workspace dep: `domain`; tests `*.test.ts`.

## Public surface
- `PlayerEngine` port with `LoadCommand` (`options`: `softwareAudio`, `audioTrackId`, `subtitleTrackId`),
  `selectAudioTrack?`, `selectSubtitleTrack?` (`null` = Off), `MediaTracks`, `TrackInfo`, `EMPTY_TRACKS`, `EngineEvent`
  (`tracks`), `EngineState`, `EngineCapabilities`, `AttemptToken`, and `bridgeNativeEngine(native, { capabilities,
  uptimeMs, now })` (`NativeEngineHandle`, `NativeLoadCommand`). `positionAt(anchor, nowMs)` clamps to `[0, durationMs]`;
  `isAtLiveEdge(anchor, nowMs, toleranceMs = LIVE_EDGE_TOLERANCE_MS)` applies the 5 s live-edge grace window (`#284`).
- `EngineError` and the 14 `EngineErrorCode`s; `toPlaybackError` gives `elvError('playback', code)`;
  `classifyError(code, httpStatus?)` gives `terminal | not-found | limit | recoverable` (`407`/`410`/`451` terminal, `458`/`460`–`463`/`469` limit).
- `@elv/playback/testing`: `createFakePlayerEngine({ scripts, now, schedule, cancel })`, a scriptable engine for tests.
  Scripts are keyed by URL and re-run on `retry` (`recreate` idles until a `load` or `retry`); `emit` injects any
  event (stale tokens too); `openMedias()`, `maxConcurrentMedias()` check the one-media rule. Inject fake timers.
  `anchorOnPlayPause` emits an extrapolated `clock` anchor (rate 1/0) after `play`/`pause`. `ENGINE_CONTRACT_CASES` is
  the framework-free suite every engine runs through an `EngineContractHarness` (`contract.ts`; the fake: `contract.test.ts`).
- `createPlaybackService({ engine, clock, timers, config? })` (`service.ts`, `service-events.ts`, `state-store.ts`, `seek-coalescer.ts`):
  `tune`, `retry` (replays `ended` VOD from 0, resumes `failed`/post-`recreate` VOD from `lastVodPositionMs`), `stop`,
  `play` (replays `ended` VOD from 0), `pause`, `seek` (coalesced ~80 ms, guards stale pre-seek clock ticks, bounded seek-settle
  deadline, and reloads `ended`/`recovering` VOD), `selectAudioTrack`, `selectSubtitleTrack` (reconciled across reloads by exact id +
  canonical `(language, label)` in `track-preferences.ts`), `getState`, `subscribe` (batched, equality-gated, `try/catch`-isolated), `dispose`.
  `pause`/`play` advance `attempt`; `anchor` freezes on non-playing states; live `atLiveEdge` tracks the 5 s grace window. `DEFAULT_PLAYBACK_CONFIG` holds spec timings.

## Recovery (spec sections 5.4 and 5.5; `recovery.ts`, `ladder.ts`, `backoff.ts`, `stall-watchdog.ts`, always wired)
- Entry: a stall of 4 s while `playing`, a frozen live clock (`positionMs` non-advancing for 4 s after first frame -> one bounded live-edge reload reset before escalating; `#148`), no `playing` 5 s after live `load` (8 s VOD), or a recoverable error. An unexpected live `ended` triggers at most one clean-end reload per tune (`#148`; VOD `ended` is untouched). Fast
  errors wait gaps 0, 1, 2, 4 s; silent timeouts escalate immediately (live tunes with no first frame skip rung 1) and
  each rung has 2 s to play (~9-11 s silent bound): 1 `retry`, 2 `load`, 3 `recreate` + `load`, 4 software audio or
  alternate (`stopMedia` before async resolve); then `failed` + `stop`. 30 s of `playing` restores budgets.
- Limit path (`http-429`, `http-509`, `connection-limit`, even while `paused`): `stop`, `limited { nextAtMs }`, wait
  2, 4, 8, then 15 s, `load`; past 60 s `failed(connection-limit)`. Same-account `tune`s are held until wait ends.
- VOD: reloads resume from last playing/seek position; `network` reconnects with backoff up to 120 s (paused time excluded).
- Pause drops pending rungs without resetting rung budget; `play` continues recovery. `surface-lost` waits for `surface`.
- Seam (internal `seam.ts`): `RecoveryHooks` + `ServiceControl`; tests use `createPlaybackServiceWith`.

## Engine contract (spec section 5.1)
- Commands are enqueue-and-return; results arrive as events echoing an `AttemptToken`. After a command with a newer
  token the engine tags later events of the current media with it. `load` starts a new media; the rest keep it.
- One media at a time: `load` closes every connection of the previous media before the first new request.
- Position never lives in React state; readers call `positionAt` on the latest `clock` anchor.

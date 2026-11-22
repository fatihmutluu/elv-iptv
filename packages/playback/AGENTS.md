# playback (`@elv/playback`)

PlayerEngine contract, PlaybackService, recovery ladder and FakePlayerEngine.

## Commands
- `pnpm --filter @elv/playback typecheck` / `test` (or `pnpm -w check` for every repository check).

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports (ports live in `@elv/domain`).
- Source-first (`src/index.ts`, `./testing` -> `src/testing/index.ts`); allowed workspace dep: `domain`; tests `*.test.ts`.

## Public surface
- `PlayerEngine` port (`LoadCommand`, `setSpeed?`, `selectAudioTrack?`, `selectSubtitleTrack?`, `MediaTracks`,
  `TrackInfo`, `EMPTY_TRACKS`, `EngineEvent`, `EngineState`, `EngineCapabilities`, `AttemptToken`) and
  `bridgeNativeEngine`. `createMonotonicClock(nowFn?)` (`#159`) guards against backwards wall-clock jumps;
  `positionAt(anchor, nowMs)` clamps to `[0, durationMs]`; `isAtLiveEdge(anchor, nowMs, toleranceMs)` applies the 5 s window (`#284`).
- `EngineError` / `toPlaybackError` / `classifyError(code, httpStatus?)`; `diagnosePlaybackFailure`, `extractRedactedHost`,
  and `createPlaybackDiagnoser({ clock, checkAccountHealth?, ttlMs? })` (`diagnoser.ts`, `#316`) classify failures with 60 s monotonic TTL caching and host-only redacted evidence.
- `@elv/playback/testing`: `createFakePlayerEngine({ scripts, now, schedule, cancel })` and `ENGINE_CONTRACT_CASES` (`contract.ts`).
- `createPlaybackService({ engine, clock, timers, config? })` (`service.ts`, `service-events.ts`, `state-store.ts`,
  `seek-coalescer.ts`, `speed-coalescer.ts`): `tune`, `retry`, `stop`, `play`, `pause`, `seek` (coalesced ~80 ms, guards stale clock ticks),
  `setSpeed` (clamped `[0.25, 4.0]`, coalesced across active seeks and in-flight transitions; `#302`), `selectAudioTrack`,
  `selectSubtitleTrack` (`track-preferences.ts`), `getState`, `subscribe`, `dispose`. `DEFAULT_PLAYBACK_CONFIG` holds spec timings.

## Recovery (spec sections 5.4 and 5.5; `recovery.ts`, `ladder.ts`, `backoff.ts`, `stall-watchdog.ts`, always wired)
- Entry: a stall of 4 s while `playing`, a frozen live clock (`positionMs` non-advancing for 4 s after first frame -> one bounded live-edge reload reset before escalating; `#148`), no `playing` 5 s after live `load` (8 s VOD), or a recoverable error. An unexpected live `ended` triggers at most one clean-end reload per tune (`#148`; VOD `ended` is untouched). Fast
  errors wait gaps 0, 1, 2, 4 s; silent timeouts escalate immediately (live tunes with no first frame skip rung 1) and
  each rung has 2 s to play (~9-11 s silent bound): 1 `retry`, 2 `load`, 3 `recreate` + `load`, 4 software audio or
  alternates (`stopMedia` before async resolve; iterates `TuneRequest.alternates` and inline `StreamRequest.alternates`,
  skipping failed resolvers and endpoints matching per-tune canonical `failedCanonicalUrls` across `url`, `finalUrl`, and
  `error.finalUrl`, `#287`) or container fallback; then `failed` + `stop`. 30 s of `playing` restores budgets.
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

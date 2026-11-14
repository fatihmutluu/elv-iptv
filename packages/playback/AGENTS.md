# playback (`@elv/playback`)

PlayerEngine contract, PlaybackService, recovery ladder and FakePlayerEngine.

## Commands
- `pnpm --filter @elv/playback typecheck` type-checks this package.
- `pnpm --filter @elv/playback test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts` and `./testing` at `src/testing/index.ts`; no build step.
- Allowed workspace dependencies: domain.
- Tests live beside the code as `*.test.ts`.

## Public surface
- `PlayerEngine` port with `LoadCommand` (`options.softwareAudio` for rung 4), `EngineEvent`, `EngineState`,
  `EngineCapabilities`, `AttemptToken`. `positionAt(anchor, nowMs)`: clock extrapolation, clamped to `[0, durationMs]`.
- `EngineError` and the 14 `EngineErrorCode`s; `toPlaybackError` gives `elvError('playback', code)`;
  `classifyError` gives `terminal | not-found | limit | recoverable`.
- `@elv/playback/testing`: `createFakePlayerEngine({ scripts, now, schedule, cancel })`, a scriptable engine for tests.
  Scripts are keyed by URL and re-run on `retry` (`recreate` idles until a `load` or `retry`); `emit` injects any
  event (stale tokens too); `openMedias()`, `maxConcurrentMedias()` check the one-media rule. Inject fake timers.
- `createPlaybackService({ engine, clock, timers, config? })`: `tune` (returns the token; a new tune supersedes the old
  one at once), `retry`, `stop`, `play`, `pause`, `seek`, `getState`, `subscribe`, `dispose`. The frozen
  `DEFAULT_PLAYBACK_CONFIG` holds the spec timings; a `resolve` unsettled after 5 s fails with `network`/`timeout`.
  Older tokens' events are dropped (`staleEventsDropped`). `nextLimitDelay(elapsedMs, attempt, config)`: limit wait.

## Recovery (spec sections 5.4 and 5.5; `recovery.ts`, always wired)
- Entry: a stall of 4 s while `playing`, no `playing` 8 s after `load`, or a recoverable error. Each rung takes a new
  token after its gap (0, 1, 2, 4 s) and has 4 s to reach `playing`: 1 `retry`, 2 `load` again, 3 `recreate` + `load`,
  4 software audio after `decoder` (if the engine has it) or the next alternate; then `failed` (last error) + `stop`.
  30 s of `playing` restores every budget. Terminal codes fail at once; `http-404` gets one rung 2 only, then fails.
- Limit path (`http-429`, `http-509`, `connection-limit`; never the ladder): `stop`, `limited { nextAtMs }` (the
  stopped media's events are ignored), wait 2, 4, 8, then 15 s, `load`; past 60 s `failed(connection-limit)`. A
  same-account `tune` is held until the wait ends (keeps `limited`, loads with its own token); others load at once.
- VOD: reloads resume where the failure happened; `network` reconnects with the same backoff for up to 120 s.
- A seek disarms the stall watchdog until the next `playing`. A pause sends nothing: pending rungs and gaps are dropped;
  `play` restarts the ladder at rung 1 (budget kept) or gives the media 8 s to play. `surface-lost` while the surface
  is gone waits for `surface created`, then rung 1. Stop, a tune, a retry, `ended` and `dispose` drop pending steps.
- Seam (internal `seam.ts`): the service calls `RecoveryHooks` (surface events whatever their token), recovery drives
  it via `ServiceControl`; tests use `createPlaybackServiceWith`. Timeouts are armed before their command is sent.

## Engine contract (spec section 5.1)
- Commands are enqueue-and-return; results arrive as events, each echoing an `AttemptToken`.
- Token adoption: after a command with a newer token the engine tags later events of the current media with it.
  `load` starts a new media; `retry`, `recreate` and the rest keep the media.
- One media at a time: `load` closes every connection of the previous media before the first new request.
- Position never lives in React state; readers call `positionAt` on the latest `clock` anchor.

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
- `PlayerEngine` port with `LoadCommand`, `EngineEvent`, `EngineState`, `EngineCapabilities`, `AttemptToken`.
- `positionAt(anchor, nowMs)`: clock extrapolation, clamped to `[0, durationMs]`.
- `EngineError` and the 14 `EngineErrorCode`s; `toPlaybackError` gives `elvError('playback', code)`;
  `classifyError` gives `terminal | not-found | limit | recoverable`.
- `@elv/playback/testing`: `createFakePlayerEngine({ scripts, now, schedule, cancel })`, a scriptable engine for tests.
  Scripts are keyed by URL and re-run on `retry`/`recreate`; `emit` injects any event (stale tokens too);
  `openMedias()` and `maxConcurrentMedias()` check the one-media rule. Inject fake-timer functions, no real timers.

- `createPlaybackService({ engine, clock, timers, config? })`: `tune` (returns the token; a new tune supersedes the old
  one at once), `retry`, `stop`, `play`, `pause`, `seek`, `getState`, `subscribe`, `dispose`. `DEFAULT_PLAYBACK_CONFIG`
  holds the spec timings. Events of older tokens are dropped and counted in `staleEventsDropped`.
- Recovery plugs in through the internal `recovery` dependency (not exported from the index): `RecoveryHooks`
  (error, stall, start timeout, and surface events whatever their token) driving the service through `ServiceControl`.
  Without it, an error or start timeout fails the tune. The start timeout is armed before `load`/`retry` is sent.

## Engine contract (spec section 5.1)
- Commands are enqueue-and-return; results arrive as events, each echoing an `AttemptToken`.
- Token adoption: after a command with a newer token the engine tags later events of the current media with it.
  `load` starts a new media; `retry`, `recreate` and the rest keep the media.
- One media at a time: `load` closes every connection of the previous media before the first new request.
- Position never lives in React state; readers call `positionAt` on the latest `clock` anchor.

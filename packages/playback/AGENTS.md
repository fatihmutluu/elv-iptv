# playback (`@elv/playback`)

PlayerEngine contract, PlaybackService, recovery ladder and FakePlayerEngine.

## Commands
- `pnpm --filter @elv/playback typecheck` type-checks this package.
- `pnpm --filter @elv/playback test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: domain.
- Tests live beside the code as `*.test.ts`.

## Public surface
- `PlayerEngine` port with `LoadCommand`, `EngineEvent`, `EngineState`, `EngineCapabilities`, `AttemptToken`.
- `positionAt(anchor, nowMs)`: clock extrapolation, clamped to `[0, durationMs]`.
- `EngineError` and the 14 `EngineErrorCode`s; `toPlaybackError` gives `elvError('playback', code)`;
  `classifyError` gives `terminal | not-found | limit | recoverable`.

## Engine contract (spec section 5.1)
- Commands are enqueue-and-return; results arrive as events, each echoing an `AttemptToken`.
- Token adoption: after a command with a newer token the engine tags later events of the current media with it.
  `load` starts a new media; `retry`, `recreate` and the rest keep the media.
- One media at a time: `load` closes every connection of the previous media before the first new request.
- Position never lives in React state; readers call `positionAt` on the latest `clock` anchor.

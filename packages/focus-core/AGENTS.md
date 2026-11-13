# focus-core (`@elv/focus-core`)

Focus graph, key model and EPG cursor model.

## Commands
- `pnpm --filter @elv/focus-core typecheck` type-checks this package.
- `pnpm --filter @elv/focus-core test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: domain.
- Tests live beside the code as `*.test.ts`.

## Key model (`keys.ts`, `interpreter.ts`)
- `createKeyInterpreter()` turns `KeyInput` (`down`/`up`/`press`, caller-supplied `time`) into `KeyEvent`s
  (`press`/`long`/`repeat`). It never reads a clock; call `tick(now)` from the host loop.
- Thresholds are constants in `keys.ts`: `LONG_PRESS_MS` 500, `REPEAT_START_HZ` 8, `REPEAT_FAST_HZ` 24,
  `REPEAT_RAMP_MS` 1500. Repeats start one slow interval after the long threshold and switch to the fast interval
  for repeats due at or after `LONG_PRESS_MS + REPEAT_RAMP_MS` of holding.
- Repeats are coalesced: after a `repeat` for a key, the host must call `acknowledge(key)`; due repeats in between
  are dropped, not queued. `reset()` clears all held keys. Digits never produce `long` or `repeat`.
- A key released after the threshold emits no `press`; a `long` the host never ticked is emitted on release.

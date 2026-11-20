# focus-core (`@elv/focus-core`)

Focus graph, key model and EPG cursor model.

## Commands
- `pnpm --filter @elv/focus-core typecheck` type-checks this package.
- `pnpm --filter @elv/focus-core test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports. Platform access goes through ports in `@elv/domain`.
- Source-first (`exports` points at `src/index.ts`, no build step). Allowed workspace dependencies: `domain`. Tests live beside code as `*.test.ts`.

## Key model (`keys.ts`, `interpreter.ts`)
- `createKeyInterpreter()` turns `KeyInput` (`down`/`up`/`press`/`cancel`/`long`, caller-supplied `time`) into `KeyEvent`s (`press`/`long`/`repeat`); never reads a clock — call `tick(now)` from the host loop (non-finite `now` ignored; overdue repeats emit at most one and advance arithmetically).
- Arrows, `channelUp`/`channelDown`, and `rewind`/`fastForward` step on the earliest input (`down` emits `press`, subsequent `up` emits nothing; orphan `up` emits one `press`). Other keys (`select`, `back`, `menu`, `playPause`, `play`, `pause`, digits) press on `up` before `LONG_PRESS_MS` so `long` stays distinguishable; digits never produce `long`/`repeat`.
- Thresholds (`keys.ts`): `LONG_PRESS_MS` 500, `REPEAT_START_HZ` 8, `REPEAT_FAST_HZ` 24, `REPEAT_RAMP_MS` 1500. Repeats coalesce until the host calls `acknowledge(key)`; `cancel` or `reset()` drops held keys silently; an `up` after a ticked `long` emits nothing.

## Focus model (`list.ts`, `scope.ts`, `store.ts`)
- Lists are index-based (`ListState`: `count`, `index`, `orientation`, `pageSize`, optional `fallbackId`); 100k-item lists allocate nothing per item and `getState()` is O(scopes + lists).
- `moveList`: orientation-axis arrows step 1 on `press`/`repeat` and `pageSize` on `long`; `channelUp`/`channelDown` always page; clamps at ends and reports `edge` when unchanged; empty lists / off-axis keys are `ignored`.
- `createFocusStore` manages a scope stack. `dispatch` returns `select`/`long` (never on empty lists), `back` (root only; pushed scopes pop instead), `backLong` (never pops), `edge`, and `key`.
- List `index` is focus memory (`popScope` restores the opener clamped to current counts). `setCount`, `focus(id, index?)`, and `activate(id)` target the topmost list with `id`; `isActive(id)` checks top scope's `active`.
- Empty-panel focus recovery: `resolveFallbackId(scope, fromId)` walks same-scope `fallbackId` links with cycle protection, preferring the first reachable sibling with `count > 0` (else the immediate valid non-self sibling). When `setCount(id, 0)` empties a scope's `active` list or `popScope()` restores an emptied active list, focus recovers to the fallback sibling and enqueues a `FocusChange`; non-active list updates never steal focus.
- `subscribe` listeners run FIFO on index, active-list, emptiness, and scope transitions.

## Select debounce (`select-guard.ts`)
- `createSelectDebounceGuard({ windowMs = 220 })` returns `{ allow(nowMs, key = ''), reset() }` suppressing duplicate Select bursts within `windowMs` per key (caller passes `nowMs`; non-monotonic `nowMs < lastAt` resets and allows; `windowMs <= 0` or non-finite disables debouncing).

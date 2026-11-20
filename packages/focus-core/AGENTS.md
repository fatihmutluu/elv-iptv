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
- Arrows, `channelUp`/`channelDown`, and `rewind`/`fastForward` step on the earliest input: a `down` gives the `press`
  (its time) and the following `up` nothing; an `up` without a `down` is one `press` at its time. The Android
  `TVEventHandler` fallback (no raw key source) delivers a tap only as its release, so there the step starts at the
  release; the raw path delivers the `down`. Other keys (`select`, `back`, `menu`, `playPause`, `play`, `pause`, digits)
  press on an `up` before the threshold, so `long` stays distinguishable; an `up` without a `down` is a `press` too.
- Thresholds are constants in `keys.ts`: `LONG_PRESS_MS` 500, `REPEAT_START_HZ` 8, `REPEAT_FAST_HZ` 24,
  `REPEAT_RAMP_MS` 1500. Repeats start one slow interval after the long threshold and switch to the fast interval
  for repeats due at or after `LONG_PRESS_MS + REPEAT_RAMP_MS` of holding.
- Repeats are coalesced: after a `repeat` for a key, the host must call `acknowledge(key)`; due repeats in between
  are dropped, not queued. `reset()` clears all held keys. Digits never produce `long` or `repeat`.
- A key released after the threshold emits no `press`; a `long` the host never ticked is emitted on release.
  An `up` of a key whose `long` a `tick` already fired emits nothing, whatever its (back-dated) time.
- `KeyInput.action` `cancel` drops a held key and emits nothing (canceled release, lost focus); repeats stop.
- `KeyInput.action` may be `long` for runtimes that only report a native long press: it becomes exactly one `long`
  event at the input's `time` (a digit becomes a `press`).
- `tick(now)` ignores a non-finite `now`. If several repeats are overdue (app suspended while a key is held) it emits at
  most one and moves the next slot to the first future one arithmetically.

## Focus model (`list.ts`, `scope.ts`, `store.ts`)
- Lists are index-based: a `ListState` is `count`, `index`, `orientation`, `pageSize`, plus optional `fallbackId`; a
  100,000-item list allocates nothing per item and `getState()` is O(scopes + lists).
- `moveList`: arrows along the orientation move one step on `press`/`repeat`, one page on `long`; `channelUp` (towards
  0) and `channelDown` always page. Moves clamp; a move that cannot change the index is `edge` with the side; a page
  that partly fits moves to the end. Empty lists and the other axis are `ignored`.
- `createFocusStore` keeps a scope stack. `dispatch` returns intents: `select`/`long` (not for empty lists), `back`
  (root only; a pushed scope is popped instead), `backLong` (never pops), `edge`, and `key` for unconsumed keys.
- The index of every list is its focus memory: `popScope` restores the opener as it was, clamped if `setCount`
  shrank it meanwhile. `setCount`, `focus(id, index?)` and `activate(id)` address the topmost list with that id;
  `isActive(id)` is true iff `id` is the top scope's `active` list.
- Empty-panel focus recovery: `resolveFallbackId(scope, fromId)` follows `fallbackId` links within the same scope with
  cycle protection, preferring the first reachable sibling with `count > 0` (or the immediate valid non-self sibling
  if all fallbacks are empty). When `setCount(id, 0)` empties a scope's `active` list or `popScope()` restores a scope
  whose active list has `count === 0`, focus automatically recovers to the resolved fallback sibling (preserving its
  focus memory) and enqueues a `FocusChange` for it; emptying a non-active list never steals focus.
- `subscribe` listeners run FIFO on index, active-list, emptiness, and `pushScope`/`popScope` transitions.

## Select debounce (`select-guard.ts`)
- `createSelectDebounceGuard({ windowMs = 220 })` returns `{ allow(nowMs, key = ''), reset() }` to suppress duplicate
  Select bursts arriving within `windowMs` for the same key. It never reads a wall clock; callers pass `nowMs`.
- Allows immediately when `nowMs - lastAt >= windowMs`, when `key` changes, after `reset()`, or on non-monotonic
  timestamps (`nowMs < lastAt`, which reset state). `windowMs <= 0` (or non-finite) disables debouncing.

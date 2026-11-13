# Focus core and 100k list gate — Design

- Status: approved (owner delegated Round 1 decisions on 2026-11-13)
- Date: 2026-11-13
- Issue: #5. Foundation spec: §4 (Focus, Lists), §5.6, §6.1, §6.2; ADR 0004 (own focus core).

## 1. Why
Every TV screen of ELV is navigated with a remote. Native focus engines on top of recycling lists lose focus when the
focused view is recycled, jump geometrically to unrelated views and cannot be tested headlessly; that is the failure
class the research found in existing React Native TV apps. ADR 0004 chose an own focus core where focus is data
(an index in a scope), and windowed lists whose rows are a presentation detail. This gate builds that core and the TV
channel list as real foundation code and proves on the Android TV emulator that 100,000 items navigate within the
budgets: remote key to highlight under 100 ms, no JavaScript task over 16 ms while navigating, no dropped frames.

## 2. Goals
- `packages/focus-core`: a pure TypeScript focus model — key model with long press and repeat, scopes with a Back stack,
  containers with focus memory, index-based list containers, and a subscribe API the UI renders from.
- `packages/ui-kit`: a TV windowed list (`TvList`) that renders a fixed pool of rows over any number of items, a focus
  ring, and one key source per runtime feeding the focus core.
- `apps/tv-mobile`: a development-only gate screen opened by deep link, with an automatic driver and instrumentation.
- `tools/`: a gate runner that installs the app on the emulator, drives it, collects metrics and compares them with a
  committed baseline; a CI job that runs it on the Android TV emulator.

## 3. Non-goals
- The EPG grid (#6), the player OSD (#7), SQLite-backed list data (the device spec), phone and desktop layouts.
- tvOS numbers on hardware and the owner's feel test on a real Apple TV (recorded later in the issue). The tvOS
  simulator run in this gate is report-only.
- Key remapping (#33), multi-column grids, search input.

## 4. Approaches considered
1. **Own pure-TS focus core + own windowed list with a fixed row pool (chosen).** ADR 0004 and research 10: focus as
   data survives recycling; a fixed pool updates one row per step; fully unit-testable.
2. Norigin spatial-navigation core with its React Native adapter. Rejected for now: young RN adapter, layout
   measurement round-trips, no list of its own; our API is shaped so it could replace the core later.
3. FlashList or LegendList with native focus. Rejected for the channel list: native focus plus recycling is the failure
   class we avoid; both stay candidates for non-focus-critical lists later.

## 5. Design

### 5.1 Key model (`focus-core`)
- `Key`: `up | down | left | right | select | back | menu | playPause | channelUp | channelDown | digit0…digit9`.
- `KeyInput { key, action: 'down' | 'up' | 'press', time }` from a runtime key source; `press` is for runtimes that
  only report presses.
- `KeyEvent { key, kind: 'press' | 'long' | 'repeat', time }` produced by a `KeyInterpreter`: a `down` followed by an
  `up` within 500 ms is `press`; a key held 500 ms fires `long` once (for `select`, `back` and the arrows) and then
  `repeat` events at a rate that starts at 8/s and rises to 24/s after 1.5 s for the arrows; a runtime that only sends
  `press` events gets presses (and its native long-press events map to `long`). Thresholds are constants with tests.
- Repeats are coalesced: if the UI has not acknowledged the previous move, at most one pending move per direction is
  kept, so a slow frame never builds a backlog.

### 5.2 Focus tree (`focus-core`)
- `FocusNode { id: string }` — stable semantic ids (spec §5.6) used by tests and accessibility.
- `ListContainer`: `count`, `index`, `orientation`, `wrap: false`, `pageSize`; handles `up/down` (or left/right), page
  moves on `channelUp/Down`, `long` + direction jumps by `pageSize`; clamps at the ends and reports `edge` so the parent
  can move focus out.
- `Scope`: a stack entry owning one active container and a memory of the last focused node per container; `back`
  pops the scope and restores the opener's focus; the root scope's `back` is reported to the app.
- `FocusStore`: `dispatch(event)`, `getState()`, `subscribe(listener)` (listeners get the changed container and new
  index only; no React import). Long `back` emits a `backLong` intent the app can route (spec §5.6: return to player).

### 5.3 Key sources (`ui-kit`)
- `useTvKeySource(store)`: Android TV and Fire OS use react-native-tvos `TVEventHandler` key events with
  `eventKeyAction` (down/up) and `BackHandler` for Back; tvOS uses `TVEventHandler` presses, `longSelect`/long events and
  the menu key (`TVEventControl.enableTVMenuKey`). One key source per runtime; focusable rows never use `onPress`.
- The source stamps `time` with `performance.now()` at receipt.

### 5.4 Windowed list (`ui-kit`)
- `TvList<T>` props: `source: ListSource<T>`, `rowHeight`, `visibleRows`, `renderRow(item, state)`, `focusLine`
  (default: the third visible row; the list slides, the ring stays), `testID`.
- `ListSource<T>`: `count(): number`, `get(index): T | undefined`, `prefetch(start, end): void`, `onChange(listener)`.
  The gate uses a synthetic source that computes rows on demand (no 100,000 objects); the SQLite source comes later.
- Rendering: a pool of `visibleRows + 4` row components keyed by slot; slot `i` shows item `start + ((i - start) mod
  pool)` so one step re-renders one slot; content offset is an `Animated.Value` driven with the native driver (short
  timing animation for single presses, direct `setValue` during repeats); the focus ring is a separate absolutely
  positioned view. No Reanimated dependency in this gate.
- Rows are memoized and receive only `item` and `focused`; the focused row gets `accessibilityState.selected` and its
  label so TalkBack can read it (verified later on hardware).

### 5.5 Gate screen and instrumentation (`apps/tv-mobile`, development builds only)
- Deep link `elviptv://gate/list?items=100000&auto=1&rate=20&moves=600` opens `GateListScreen`; the scheme is
  `elviptv`. Production builds do not include the screen (the route is registered only when `APP_VARIANT` is
  `development`).
- The auto-driver feeds `KeyEvent`s through the same `FocusStore.dispatch` at `rate` per second: down-holds, page
  jumps, up-holds, single presses, a scripted 600-move sequence ending where it started.
- Metrics per move: `t0` at dispatch (or key-source receipt for real keys) and `t1` in the first
  `requestAnimationFrame` after the focused row and ring committed; an event-loop lag sampler (4 ms interval) records
  the longest gap; counts of moves, coalesced repeats and focus losses (focused index not on screen after a move).
- Results are printed once as a single logcat/console line `ELV_GATE {json}` (p50/p95/max key-to-highlight,
  max JS gap, moves, losses).

### 5.6 Gate runner and CI (`tools/`)
- `pnpm gate list [--avd elv_tv] [--build] [--real-keys 60]`: builds the development APK when asked, installs it,
  resets `dumpsys gfxinfo`, opens the deep link, waits for `ELV_GATE`, reads `gfxinfo` (total frames, janky %, 90/95/99th
  percentile frame times), optionally sends N real D-pad presses with `adb shell input keyevent` at 1 per second to
  measure real-key latency, and writes `gate-list.json`.
- Comparison: `docs/learned/gates/list-android-tv.json` holds the committed baseline; a metric fails when it exceeds
  `max(baseline × 1.10, baseline + slack)` (slack 5 ms for latency, 2 points for janky %, 4 ms for JS gap) or the
  absolute budget (p95 key-to-highlight 100 ms, max JS gap 16 ms, janky 0 % target recorded as a warning on emulators).
- CI: a `gate-list` job in `native.yml` (Ubuntu runner with KVM, the Android TV system image, pinned emulator action)
  runs the gate three times and compares the median. The job is required only after five green runs on `main`;
  until then it reports.
- tvOS: the `tvos` CI job runs the auto-driver in the simulator via `simctl openurl` and records `ELV_GATE` output as a
  report-only artifact.

## 6. Testing
- `focus-core`: Vitest with simulated key sequences — interpreter timings (press, long, repeat ramp, coalescing),
  list moves, edges, paging, scopes and Back restore, focus memory, 100,000-item lists without allocation per item;
  property test that any key sequence keeps the index within bounds and never loses focus. Coverage ≥ 90 % lines.
- `ui-kit`: Jest + RNTL — `TvList` renders only the pool, re-renders one slot per step (render counter), keeps the
  focused row on the focus line, exposes `testID`s and accessibility state; the key source maps platform events to
  `KeyInput` (mocked `TVEventHandler`).
- Gate: the runner is unit-tested for parsing `gfxinfo` and `ELV_GATE` lines and for the comparison rule; the real run
  is recorded in the issue with device, build and numbers.

## 7. Constraints
- `focus-core` is pure (no `react`, `react-native`, `expo*`, `electron`, `node:*`); `ui-kit` may import `react-native`
  and `focus-core`; the gate screen lives in the app only.
- No new runtime dependency for the list (built-in `Animated`); react-native-tvos APIs only through the key source.
- Files ≤ 400 lines; exported APIs documented; package `AGENTS.md` files updated; `docs/learned/` gets an entry if a
  measurement surprises us.

## 8. Left to the builder
Exact constants beyond those listed, the synthetic row content, the auto-driver's sequence details, and the CI emulator
image tag, as long as §6 holds and the gate output format stays stable.

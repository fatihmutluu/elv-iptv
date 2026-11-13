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
  Changed: arrows and channel keys press on the earliest input, `down` or else the release (§9).
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
  Changed: Android long Back is deferred to #7 (§9).

### 5.3 Key sources (`ui-kit`)
- `useTvKeySource(store)`: Android TV and Fire OS use react-native-tvos `TVEventHandler` key events with
  `eventKeyAction` (down/up) and `BackHandler` for Back; tvOS uses `TVEventHandler` presses, `longSelect`/long events and
  the menu key (`TVEventControl.enableTVMenuKey`). One key source per runtime; focusable rows never use `onPress`.
- The source stamps `time` with `performance.now()` at receipt.
- Changed: the hook is `useTvKeySource(onInput)`, tvOS Menu is `back`, and a focusable root is required (§9).

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
- Changed: `renderRow(item, focused)` and at most 3 re-rendered rows per step instead of one slot (§9).

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
- Changed: measured on a JS-bundled release build of the development variant; the lag sampler is replaced by
  `maxJsGapMs` and `maxFrameStallMs`; the line also carries `scripted` (§9).

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
- Changed: janky % rules, the CI baseline file, the separate tvOS job, the real-press check, comparability and the
  per-run report (§9); the runner's flags are listed in `tools/AGENTS.md`.

## 6. Testing
- `focus-core`: Vitest with simulated key sequences — interpreter timings (press, long, repeat ramp, coalescing),
  list moves, edges, paging, scopes and Back restore, focus memory, 100,000-item lists without allocation per item;
  property test that any key sequence keeps the index within bounds and never loses focus. Coverage ≥ 90 % lines.
- `ui-kit`: Jest + RNTL — `TvList` renders only the pool, re-renders one slot per step (render counter), keeps the
  focused row on the focus line, exposes `testID`s and accessibility state; the key source maps platform events to
  `KeyInput` (mocked `TVEventHandler`). Changed: at most 3 rows per step (§9).
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

## 9. Decisions made during implementation
Where sections 5 and 6 above differ, this list wins. Each line gives the decision and why.
- Arrows and `channelUp`/`channelDown` step on the earliest input the runtime delivers: on `down` (the `press` carries
  the down time and the following `up` emits nothing), otherwise on an `up` without a `down` (one `press` at its time).
  Holding an arrow gives `long` at 500 ms, then repeats; holding a channel key repeats after 500 ms without a `long`.
  Select, back, menu, playPause and digits keep press-on-up. Why: §1 measures "remote key to highlight", which a user
  counts from pressing, so the step must not wait for a release the runtime does not need.
- Android TV remote events, verified on the API 36 emulator with react-native-tvos 0.88 (`adb shell input keyevent`,
  with and without `--duration`): a tap reaches `TVEventHandler` only as its release (`eventKeyAction` 1); a hold
  arrives as `long<Key>` with action 0 at the long-press timeout (about 430 ms) and action 1 at the release, with no
  repeats in between; Select behaves the same (`select` 1; `longSelect` 0 and 1). The key source drops the long
  release, so a held arrow jumps one page and does not repeat. On Android the measured key-to-highlight therefore
  starts at the key release (a hold: at the long-press event), not at the physical press.
- The key source is `useTvKeySource(onInput)`, not `(store)`: the host feeds a key interpreter (which needs `tick` and
  `acknowledge`) and then the store, so the source stays a thin platform adapter.
- tvOS Menu (and its native long press) is `back`; Android `KEYCODE_MENU` stays `menu`. Why: the Apple TV remote's
  Menu button is its Back button.
- Android long Back (`backLong`) is deferred to the player OSD gate (#7). Why: `BackHandler` cannot observe a long press;
  it needs a native key hook, and only the player needs it.
- Rows render through `renderRow(item, focused)`: §5.4 also says rows receive only `item` and `focused`, so a boolean
  is that state.
- Render-count bound: at most 3 rows re-render per step (the entering slot and the rows losing and gaining focus),
  independent of the pool size, instead of "one slot". Why: `focused` moves between two rows on every step.
- Key events need a focused native view: the gate screen root is `focusable` with `hasTVPreferredFocus`. Why: without
  one Android delivers no remote keys to `TVEventHandler`, not even `adb shell input keyevent`.
- The gate is keyed on `APP_VARIANT` (app config `extra.gate`), never `__DEV__`, and is measured on a JS-bundled
  release build of the development variant. Why: development-mode JS would make the 100 ms and 16 ms budgets meaningless.
- The 4 ms lag sampler is replaced. It fires once per frame on React Native Android, so it measured frame quantisation.
  `maxJsGapMs` is now the longest synchronous work of a move (dispatch to end of commit; enforced: budget 16 ms,
  slack 4 ms); `maxFrameStallMs` (slowest animation-frame delta minus 0.7 of the median) only warns on emulators.
  Calibration on the emulator: idle 10.2 to 10.6 ms, a 20 ms stall 9.9 to 12.3 ms (not detected), a 30 ms stall 18.5 ms.
  Earlier facts (AVD `elv_tv`, `pnpm gate list --runs 3 --real-keys 60`, 20 moves/s): the 4 ms `setInterval` fired about
  every 16.7 ms idle and 22 ms at worst, vsync slips reached 27 ms, the old median-relative formula read a 30 ms stall
  as only 13.4 ms, and the commit-333f2ec baseline had per-run JS gaps of 4.95 / 5.21 / 5.11 ms and stalls of
  10.46 / 10.91 / 10.36 ms.
- Janky frames: the legacy `gfxinfo` figure carries the relative rule (2-point slack); the deadline-based figure only
  warns on emulators. Why: it swung between 50 and 73 % across identical emulator runs.
- CI compares with its own baseline file, `docs/learned/gates/list-android-tv-ci.json`, and checks only focus losses
  (budgets warn, see below) until a green CI run seeds it. Why: a software-GPU CI emulator is not comparable with the
  local one.
- Absolute budgets are enforced on the local host-GPU emulator and on hardware; CI runs `pnpm gate list --budgets warn`,
  which reports them as warnings while regressions against the CI baseline (issue #5: "+10 % fails") and focus losses
  still fail. Why: on the CI emulator the per-move JS work median was 16.02 ms (runs 23.79 / 16.02 / 14.9 ms) against
  5.1 ms locally, so the 16 ms budget measured the runner, not the code.
- The tvOS gate is a separate report-only job (push to `main` and manual runs), not part of the required `tvos` job.
  Why: it needs a Release build of the development variant; changing `tvos` would change what the required check validates.
- On iOS the gate line is printed with `console.error`, and the tvOS job filters the simulator log by the message text
  (with a screenshot on timeout). Why: release builds drop info-level JS logs, and the first run captured nothing.
- The runner fails a real-key burst when fewer moves arrive than presses were sent. Why: a dropped remote key is a
  user-visible failure the gate exists to catch.
- Runs compare on items and `scripted` (every event the driver emitted), not `moves`. Why: a coalesced repeat lowers
  `moves`, which made a run with coalescing "not comparable" instead of a warning.
- The runner's report keeps every run next to the median and warns when the worst run breaks a budget the median meets.
  Why: the median judges the gate but can hide a single bad run.

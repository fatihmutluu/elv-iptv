# Android remote keys — Design

- Status: approved (owner delegated all development decisions on 2026-11-14)
- Date: 2026-11-14
- Issue: #43. Builds on the focus list gate spec (`2026-11-13-focus-list-gate-design.md`, §5.1, §5.3, §9) and the
  foundation spec §4 (Focus) and §5.2 (layer rules).

## 1. Why
The list gate (#5) verified how react-native-tvos 0.88 hands remote keys to JavaScript on Android TV: a tap arrives only
at its release, and a hold arrives as one `long<Key>` after about 430 ms plus its release, with no repeats. Three things
follow that JavaScript cannot fix:

1. Key-to-highlight counts from the release, so the user waits for the finger to lift before focus moves.
2. Holding an arrow pages once and never repeats, so a 100,000-item list cannot be scrolled by holding a direction.
3. A long Back is not observable, but the remote grammar needs it ("long Back returns to the player", foundation §4).

The focus core already models down, up, long and repeat (it was built for that); only the Android input path is
missing. This change adds a small Expo native module that forwards the raw Android key events and wires it into the
existing key source, so Android TV and Fire OS behave like the model says.

## 2. Goals
- A native module `modules/remote-keys` (`@elv/remote-keys`, Android only) that forwards every key down (first event,
  not system repeats) and every key up of the app's window to JavaScript, with the event's age.
- `packages/ui-kit`: a typed port for that source, an adapter that maps Android key codes to focus-core `KeyInput`s, a
  provider through which the app injects the source, and `useTvKeySource` preferring it on Android.
- `packages/focus-core`: a `cancel` input that releases a held key without emitting anything.
- `apps/tv-mobile`: wires the module into the provider at the root; the gate screen handles `cancel`.
- `tools/`: the gate runner measures real keys from the press and gains a hold check; the local baseline is refreshed.

## 3. Non-goals
- tvOS: it keeps `TVEventHandler` presses and native long events (the Siri Remote reports no down/up to React Native).
- Key remapping (#33), separate play and pause semantics, fast-forward and rewind keys (the player gate, #7).
- Exiting the app with Back on a root screen (deferred in the list gate spec §9; Back stays consumed as today).
- Changing react-native-tvos itself, or Android's native focus movement.
- Keys in other windows (a React Native `Modal`, which is a separate dialog window, the dev menu, system dialogs). TV
  screens keep every surface in the main activity window: overlays are focus-core scopes rendered in the tree, and TV
  code never uses `Modal` (a documented rule in `packages/ui-kit/AGENTS.md`, enforced by a Biome restricted import for
  `Modal` from `react-native` in `packages/ui-kit`, `packages/features` and `apps/tv-mobile` if Biome supports
  named-import restrictions, otherwise documented only).

Anti-goals: the module must never swallow a key (TextInput, IME and native focus keep working), never crash the app
when it is missing (iOS, web, a build without it), and never put product logic in Kotlin.

## 4. Landscape
- react-native-tvos 0.88 `TVEventHandler`: verified behaviour above; the maintainers moved Android to release-only
  events years ago and expose no switch for raw down events.
- `expo-key-event` (MIT, 1.9.0): keyboard-oriented, web-style key names (`ArrowRight`), captures through a focused native
  view, no event time, no TV claims, no Back. It would fight our single focusable root and lose keys when another native
  view (player surface, text field) holds focus.
- `react-native-keyevent`, `react-native-hw-keyboard-event`, `react-native-nitro-keyevent`: all need hand edits of
  `MainActivity`, which `expo prebuild` regenerates; we never edit generated native folders.
- Expo's `ReactActivityLifecycleListener` offers `onCreate`, `onResume`, `onPause`, `onDestroy`, `onNewIntent`,
  `onBackPressed`; no key hooks.

## 5. Approaches considered
1. **Wrap the activity window's `Window.Callback` from the module (chosen).** The window callback sees every key event
   of the window before the activity and the view tree. The module installs a delegating callback when the activity
   comes to the foreground; no `MainActivity` change, no config plugin, independent of which view has focus. Cost: the
   module must re-install on a new activity and delegate every callback method faithfully.
2. A config plugin that patches `MainActivity.kt` to override `dispatchKeyEvent`. Works, but string-patches generated
   Kotlin on every prebuild and breaks silently when Expo changes the template.
3. A focused native view (the `expo-key-event` model). Rejected: keys depend on native focus, which is exactly what our
   focus core replaces; it would conflict with the focusable root and with future native views.
4. Patching react-native-tvos (patch-package) to emit down events. Rejected: a fork of a moving dependency, and it still
   would not report a long Back.

## 6. Design

### 6.1 Native module (`modules/remote-keys`)
- Created with `pnpm scaffold module remote-keys` (skill `add-package`); `expo-module.config.json` lists only the
  `android` platform and its module class. The TypeScript entry imports only `expo-modules-core`.
- Kotlin module `ElvRemoteKeys` with one event `onKey`. Payload:
  `{ action: 'down' | 'up', keyCode: number, canceled: boolean, ageMs: number }` for keys, where
  `ageMs = SystemClock.uptimeMillis() - event.eventTime` at the moment of sending (never negative), and
  `{ action: 'blur' }` when the window loses focus (`onWindowFocusChanged(false)`: a dialog, the dev menu, Home),
  because the release of a key held at that moment goes to another window and never reaches ours.
- Forwarding rule, a pure Kotlin function so it can be unit-tested on the JVM: forward `ACTION_DOWN` only when
  `repeatCount == 0`; forward every `ACTION_UP` (with `canceled` from `FLAG_CANCELED`); ignore `ACTION_MULTIPLE` and
  every event with `FLAG_FALLBACK` (Android re-dispatches an unhandled `ESCAPE`, `BUTTON_B` or `BUTTON_A` as a
  fallback Back or Select; the original already arrived). System auto-repeats are dropped because the focus core runs
  its own repeat clock.
- Capture: a `Window.Callback` that delegates every method to the callback it wraps, including the interface's default
  methods (Kotlin `by` delegation skips Java default methods, so those are overridden explicitly).
  `dispatchKeyEvent` forwards first, then returns the wrapped callback's result: the module never consumes a key.
  `onWindowFocusChanged` sends `blur` on a loss of focus, then delegates.
- Install on `OnActivityEntersForeground` and when JavaScript starts observing `onKey`, on the current activity;
  installing is idempotent (a window whose callback is already ours is left alone). The module never unwraps (another
  library may have wrapped ours); when JavaScript stops observing, it stops sending.
- Threading: `dispatchKeyEvent` runs on the main thread; `sendEvent` is used as is.
- JS API (`src/index.ts`): `remoteKeys: RemoteKeySource | null`, where
  `RemoteKeySource = { addListener(listener: (e: RemoteKeyEvent) => void): { remove(): void } }`, built on
  `requireOptionalNativeModule('ElvRemoteKeys')`; `null` when the native module is absent (iOS, web).
  The module declares its own structural types; it does not import ui-kit (layer rules: modules import only
  `expo-modules-core` and playback types).

### 6.2 Port, adapter and provider (`packages/ui-kit/src/tv/`)
- `AndroidKeySource` and `AndroidKeyEvent`: structural types identical in shape to the module's, declared in ui-kit, so
  the app can pass the module value without either package importing the other.
- `mapAndroidKeyCode(keyCode): Key | undefined`:
  - D-pad 19/20/21/22 → `up`/`down`/`left`/`right`.
  - `DPAD_CENTER` 23, `ENTER` 66, `NUMPAD_ENTER` 160, `BUTTON_A` 96 → `select`.
  - `BACK` 4, `BUTTON_B` 97, `ESCAPE` 111 → `back`.
  - `MENU` 82 → `menu`.
  - `MEDIA_PLAY_PAUSE` 85, `MEDIA_PLAY` 126, `MEDIA_PAUSE` 127 → `playPause`.
  - `CHANNEL_UP` 166, `PAGE_UP` 92 → `channelUp`; `CHANNEL_DOWN` 167, `PAGE_DOWN` 93 → `channelDown`.
  - `0`–`9` (7–16) and `NUMPAD_0`–`NUMPAD_9` (144–153) → `digit0`–`digit9`.
  - Anything else → `undefined`.
- `createAndroidKeyAdapter()`, stateful per hook instance, returns `(event, now) => KeyInput[]`, tracking held keys by
  their mapped `Key` (two codes for one key, such as `DPAD_CENTER` and `ENTER`, share one record):
  - `time = now - min(max(0, event.ageMs), 100)`. Why the cap: after a JavaScript stall a quick press's down and up
    arrive late together; back-dating the down by the whole stall would let a tick between them fire `long`. 100 ms
    covers the normal native-to-JS delay, so latency still counts from the press.
  - A `down` of a key that is not held records it and gives one `down`; a `down` of a held key gives nothing.
  - An `up` of a held key gives one `up`, or one `cancel` when `canceled`, and clears the record.
  - An `up` of a key that is not held gives nothing. This is what keeps a key pressed on one screen from stepping the
    screen that mounts before its release (acceptance criterion 4).
  - `blur` gives one `cancel` per held key (at `now`) and clears every record.
  - Unmapped key codes give nothing.
- `RemoteKeysProvider({ android, children })` and a context read by `useTvKeySource`; `android` is an
  `AndroidKeySource | null`.
- `useTvKeySource(onInput)`:
  - On Android with a source from the provider: subscribe to it through a fresh adapter; do not subscribe to
    `TVEventHandler` (it would deliver every key a second time); keep the `BackHandler` listener but only to consume
    the default (return `true`), without forwarding, because Back already arrives as raw down and up.
  - Everywhere else (tvOS, Android without a provider or with `null`): today's behaviour, unchanged.
  - Key stamps stay on the `performance.now()` clock.
- `toKeyInput` stays for the `TVEventHandler` path. The ui-kit rule "only `useTvKeySource` touches `TVEventHandler`,
  `TVEventControl` and `BackHandler`" still holds.

### 6.3 Focus core (`packages/focus-core`)
- `KeyInput.action` gains `'cancel'`: it removes the key from the held set and emits nothing (no `press`, no `long`, no
  further `repeat`). A `cancel` for a key that is not held emits nothing.
- An `up` after the key's `long` already fired (from `tick`) emits nothing, whatever the up's time. Why: the raw source
  back-dates inputs by `ageMs` while `tick` runs on the current time, so a release stamped just under
  `LONG_PRESS_MS` can arrive after the tick fired `long`; it must not also `press`. This is the documented model
  ("a key released after the threshold emits no press") made robust to late releases.
- Everything else is unchanged; coverage stays at 100% lines.

### 6.4 App (`apps/tv-mobile`)
- Depends on `@elv/remote-keys` (`workspace:*`) so Expo autolinking links it into the Android build.
- `App` wraps its tree in `RemoteKeysProvider` with `remoteKeys` from the module.
- `GateListScreen`'s input handler treats `cancel` like `up` for its held-key bookkeeping and the ticker.
- The `ELV_GATE` line gains `intents`: counts per focus-store intent kind (`select`, `long`, `back`, `backLong`,
  `edge`, `key`), so a hold of Back on a device shows up as `backLong` in the printed line.

### 6.5 Gate (`tools/`) and baseline
- `--real-keys N` needs no change in how it sends keys; with the raw source the measured latency now starts at the
  press (`t0` is the `down`'s time).
- New `--real-hold <ms>`: after the auto runs (and the real-key burst, if any), restart the app in manual mode, send
  one `input keyevent --duration <ms> KEYCODE_DPAD_DOWN`, read the line printed after the idle flush, and check its
  `moves` against the count the focus-core constants predict for that hold (one press, one `long` page at 500 ms, then
  repeats at 8 Hz, switching to 24 Hz after 1500 ms more) within a tolerance of ±3 moves for adb and tick jitter.
  Fewer than expected minus the tolerance or more than expected plus the tolerance fails the run. The report records
  `realHold { holdMs, moves, expected }`. The constants are mirrored in `tools` with a test that pins them to
  focus-core's values.
- The local baseline `docs/learned/gates/list-android-tv.json` is refreshed (real keys now from the press, plus a
  2,000 ms hold). `realHold` is recorded for information only: comparison never uses it (the hold check is absolute),
  and `--write-baseline` refuses a run whose hold check failed. The CI baseline is not reseeded by this change; the CI
  job keeps its flags.
- `.github/workflows/native.yml`: the `gate` path filter gains `modules/**`.

### 6.6 Docs
- `packages/ui-kit/AGENTS.md` (TV list and key source): the Android raw path, the provider, orphan-up rule, the
  `BackHandler` change. `packages/focus-core/AGENTS.md`: `cancel`. `apps/tv-mobile/AGENTS.md`: the provider.
  `modules/remote-keys/AGENTS.md`: the capture rules of §6.1. `tools/AGENTS.md`: `--real-hold`.
- The list gate spec §9 gets a line pointing here for the Android input path.

## 7. Testing
- Kotlin: a JVM unit test for the forwarding rule (down with repeat 0 forwarded, down with repeat > 0 dropped, up
  forwarded with `canceled`, multiple and fallback events ignored), run by Gradle in the `android-tv` CI job.
- ui-kit (Jest, as the existing key-source tests): the key-code table; the adapter (time from `ageMs`, seen and unseen
  ups, `cancel`, `blur` cancelling every held key, two codes of one key, unmapped codes); `useTvKeySource` with a fake provider source (no `TVEventHandler` subscription, Back
  consumed without a second input, cleanup removes the listener, tvOS and provider-less Android unchanged).
- focus-core (Vitest): `cancel` while held, after `long`, during repeats, and for a key that is not held; an `up` stamped
  before the threshold but arriving after `tick` fired `long` emits nothing.
- tv-mobile (Jest): the gate screen with a fake source — a hold produces press, one page at 500 ms, repeats until the
  release and nothing after it; a key down before mount and up after mount moves nothing; `App` passes the module value
  (mocked) to the provider.
- Device, Android TV: on the `elv_tv` emulator (API 36), `pnpm gate list --real-keys 60 --real-hold 2000` passes.
- Device, Fire OS stand-ins (foundation spec: Fire OS is tested on Android TV AVDs at API 28 and 30 without Google
  APIs; there is no Fire TV hardware): on `elv_fire_os7` (API 28) and `elv_fire_os8` (API 30), the gate screen in
  manual mode gets a press, a 2 s hold of Down and a 1 s hold of Back. `input keyevent --duration` needs API 33, so
  holds there use the emulator console: `adb emu event send EV_KEY:<KEY_NAME>:1` then `EV_KEY:<KEY_NAME>:0` (Linux
  input key names, e.g. `KEY_DOWN`, `KEY_BACK`). The printed line must show the moves of the hold and `backLong` 1.
  Results go in the PR.

## 8. Acceptance (from #43)
1. A press moves focus on key down on the Android TV emulator; `pnpm gate list --real-keys 60` measures from the press.
2. Holding an arrow pages once at the long threshold, then repeats at the interpreter's rate until release, with no
   moves after release.
3. Long Back reaches the focus core as `back` + `long` on Android TV and Fire OS (Fire OS checked on its API 28/30
   emulator stand-ins, §7).
4. A press arriving while another screen opens does not step the new screen.
5. Module tests and the gate baseline updated; `packages/ui-kit/AGENTS.md` and the spec record the new event path.

## 9. Left to the builder
- The exact Expo Modules API calls for SDK 58 (event declaration, observing hooks, current activity); check the Expo
  docs (context7) rather than memory.
- How autolinking finds a workspace module from `apps/tv-mobile` under pnpm (dependency link versus a modules
  directory setting), and the Gradle project name for the module's unit test.
- Names of internal helpers and test files.

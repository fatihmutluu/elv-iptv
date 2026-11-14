# remote-keys (`@elv/remote-keys`)

Android-only Expo module that reports the main window's raw remote keys to JavaScript, because react-native-tvos 0.88
delivers TV keys only at release and never repeats holds (issue #43).
Spec: `docs/superpowers/specs/2026-11-14-android-remote-keys-design.md`.

## API
- `remoteKeys: RemoteKeySource | null` from `src/index.ts`; `null` where the native module is absent (iOS, web).
  `addListener(fn)` subscribes to the native event `onKey` and returns `{ remove() }`; it hands `fn`
  `{ action: 'down' | 'up', keyCode, canceled, ageMs }` or `{ action: 'blur' }`.
- Native module name `ElvRemoteKeys`: event `onKey` with `{ action, keyCode, canceled, eventTime }` (the `KeyEvent`'s
  uptime stamp) or `{ action: 'blur' }`, and the synchronous function `uptimeMs()` (`SystemClock.uptimeMillis()`).
  `ageMs = max(0, uptimeMs() - eventTime)` is computed in `src/index.ts` when the listener receives the event, so
  the wait for a busy JS thread counts.
- The types are structurally identical to ui-kit's `AndroidKeySource`; neither package imports the other. The app passes
  `remoteKeys` to ui-kit's `RemoteKeysProvider`.

## Capture rules (spec 6.1)
- `ForwardingWindowCallback` wraps `window.callback` of the current activity, on the UI thread, on
  `OnActivityEntersForeground` and when JS starts observing `onKey` (that hook runs on the JS thread); wrapping is
  idempotent and never unwrapped. It delegates every `Window.Callback` method, including the Java default ones, with
  nullable reference parameters where the SDK allows. Main window only: dialogs and other windows are not seen.
- `KeyForwarding.action`: forward `ACTION_DOWN` only with `repeatCount == 0`, every `ACTION_UP` (with `canceled` from
  `FLAG_CANCELED`); drop `ACTION_MULTIPLE`, `FLAG_FALLBACK` and `FLAG_SOFT_KEYBOARD` (IME-injected) events. Window
  focus loss sends `blur`.
- Never consume a key: `dispatchKeyEvent` always returns the wrapped callback's result. While a native text field has
  focus the raw path still forwards hardware D-pad keys; a text-entry mode that suspends the key source is issue #48.
- Raw Back depends on Android dispatching `KEYCODE_BACK` to the window; enabling `enableOnBackInvokedCallback`
  (predictive back) on API 33+ would remove Back and long Back from the raw path.
- Events go to a process-wide sink in `KeyForwarding`, set on `OnStartObserving` and cleared (only if still its own) on
  `OnStopObserving` / `OnDestroy`, so a JS reload (new module, same window) reattaches. Sink failures never block
  delegation.

## Rules
- Imports `expo-modules-core` and playback types only; the app wires the module.
- Platforms: `android` only (`expo-module.config.json`, module class `ElvRemoteKeysModule`).
- Autolinking finds the module through the `@elv/remote-keys` dependency of `apps/tv-mobile`; the Gradle project is
  `:elv-remote-keys`. Never edit `apps/tv-mobile/android`; run `pnpm run:app android-tv build` after changing native
  config.

## Tests
- TypeScript: `pnpm --filter @elv/remote-keys test` (Vitest, `expo-modules-core` mocked).
- JVM (JUnit 4, no device): after `pnpm run:app android-tv build`, in `apps/tv-mobile/android` run
  `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-remote-keys:testDebugUnitTest` (`./gradlew` on Linux/macOS).
  Gradle needs `ANDROID_HOME` (or `local.properties`). The release unit-test task does not exist for this library.
  Tests that set the process-wide sink clear it in `@After`.

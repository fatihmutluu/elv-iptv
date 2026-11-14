# remote-keys (`@elv/remote-keys`)

Android-only Expo module that reports the main window's raw remote keys to JavaScript, because react-native-tvos 0.88
delivers TV keys only at release and never repeats holds (issue #43). Spec: `docs/superpowers/specs/2026-11-14-android-remote-keys-design.md`.

## API
- `remoteKeys: RemoteKeySource | null` from `src/index.ts`; `null` where the native module is absent (iOS, web).
  `addListener(fn)` subscribes to the native event `onKey` and returns `{ remove() }`.
- Native module name `ElvRemoteKeys`, event `onKey`. Payload `{ action: 'down' | 'up', keyCode, canceled, ageMs }` or
  `{ action: 'blur' }`. `ageMs` is `uptimeMillis - event.eventTime` at sending, never negative.
- The types are structurally identical to ui-kit's `AndroidKeySource`; neither package imports the other. The app passes
  `remoteKeys` to ui-kit's `RemoteKeysProvider`.

## Capture rules (spec 6.1)
- `ForwardingWindowCallback` wraps `window.callback` of the current activity on `OnActivityEntersForeground` and when JS
  starts observing `onKey`; wrapping is idempotent and never unwrapped. It delegates every `Window.Callback` method,
  including the Java default ones. Main window only: dialogs and other windows are not seen.
- `KeyForwarding.action`: forward `ACTION_DOWN` only with `repeatCount == 0`, every `ACTION_UP` (with `canceled` from
  `FLAG_CANCELED`); drop `ACTION_MULTIPLE` and `FLAG_FALLBACK` events. Window focus loss sends `blur`.
- Never consume a key: `dispatchKeyEvent` always returns the wrapped callback's result.
- Events are sent only while JS observes (`OnStartObserving` / `OnStopObserving`).

## Rules
- Imports `expo-modules-core` and playback types only; the app wires the module.
- Platforms: `android` only (`expo-module.config.json`, module class `ElvRemoteKeysModule`).
- Autolinking finds the module through the `@elv/remote-keys` dependency of `apps/tv-mobile`; the Gradle project is
  `:elv-remote-keys`. Never edit `apps/tv-mobile/android`; run `pnpm run:app android-tv build` after changing native config.
- `knip.ts` ignores the app dependency until the app imports the package.

## Tests
- TypeScript: `pnpm --filter @elv/remote-keys test` (Vitest, `expo-modules-core` mocked).
- JVM (JUnit 4, no device): after `pnpm run:app android-tv build`, in `apps/tv-mobile/android` run
  `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-remote-keys:testDebugUnitTest` (`./gradlew` on Linux/macOS).
  Gradle needs `ANDROID_HOME` (or `local.properties`). The release unit-test task does not exist for this library.

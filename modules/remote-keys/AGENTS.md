# remote-keys (`@elv/remote-keys`)

Android and Apple tvOS Expo module forwarding raw remote key phases (`down`/`up`/`cancel`/`blur`, `#43`, `#414`)
and axis-locked Siri Remote directional pan gestures on tvOS (`#225`).
Specs: `docs/superpowers/specs/2026-11-14-android-remote-keys-design.md`,
`docs/superpowers/specs/2026-11-23-wave-c7-apple-tvos-polish-design.md`.

## API
- `remoteKeys: RemoteKeySource | null` (`src/index.ts`): subscribes to `onKey` and reports
  `{ action: 'down' | 'up', keyCode, canceled, ageMs }` or `{ action: 'blur' }`, where `ageMs = max(0, uptimeMs() - eventTime)`.
- `remotePanGestures: RemotePanGestureSource | null` (`src/index.ts`): present on Apple tvOS (`setPanGestureEnabled` +
  `onPanGesture` emitting `{ axis: 'horizontal' | 'vertical', phase, translation, velocity }`); `null` on Android/web.
- Structurally matches `@elv/ui-kit`'s `AndroidKeySource` and `@elv/features`'s `TvPanGestureEvent`; `apps/tv-mobile` wires both.

## Apple tvOS capture (`ios/Core/`, `ios/Apple/ElvRemoteKeysModule.swift`)
- Compiles on both iOS (safe no-op) and tvOS (`#if os(tvOS)`). `ios/Core/` is pure `Foundation` (`swift test --package-path modules/remote-keys/ios`).
- `TvPressKeyMap` maps `ApplePressKind` to canonical keyCodes (`19,20,21,22,23,4,85,92,93`) with held-key tracking in `ApplePressTracker`.
- `DirectionalPanPolicy` locks axis after `18 pt` deadzone and `1.35x` dominance ratio, ignoring orthogonal drift and cancelling on disable.
- `TvPressObserverGestureRecognizer` (non-consuming, simultaneous) attaches to the key `UIWindow` while `onKey` is observed, emits `blur`
  on `willResignActiveNotification`, and cleans up on `OnStopObserving`/`OnDestroy`. `TvDirectionalPanGestureRecognizer` starts disabled.

## Android capture (`android/`, spec 6.1)
- `ForwardingWindowCallback` wraps `window.callback` on UI thread (`OnActivityEntersForeground` + `onKey` observe) via
  `WeakHashMap<Any, WeakReference<ForwardingWindowCallback>>` (delegate walk <= 6) without retaining GC cycles (`#439`).
- Modal/dialog windows (`KeyForwarding.wrapDialog` / `installModalWindows` via API 29+ `WindowInspector`) forward keys cleanly (`#439`).
- Forwards `ACTION_DOWN` (`repeatCount == 0`) and every `ACTION_UP` (`canceled` from `FLAG_CANCELED`); drops `ACTION_MULTIPLE`,
  `ACTION_FALLBACK`, and `FLAG_SOFT_KEYBOARD`. Window focus loss and `OnActivityEntersBackground` send `blur`.
- Never consumes keys; JS `TvTextInput` / `TextEntryBoundary` suspends non-`back` keys during text entry (`#48`).
- Process-wide `AtomicReference` sink in `KeyForwarding` uses `compareAndSet` on stop/destroy so JS reloads reattach cleanly.

## Rules & Tests
- Imports `expo-modules-core` only; platforms `android` & `apple` (`:elv-remote-keys` / `ElvRemoteKeys`). Never edit generated `android/` or `ios/` in `apps/tv-mobile`.
- TS: `pnpm --filter @elv/remote-keys test`. Swift 6: `swift test --package-path modules/remote-keys/ios`.
- JVM: `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-remote-keys:testDebugUnitTest` (tests clear sink in `@After`).

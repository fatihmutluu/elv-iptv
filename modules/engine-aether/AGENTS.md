# engine-aether (`@elv/engine-aether`)

Apple-only Expo module (tvOS, iOS, iPadOS): the AetherEngine 7.66.1 `PlayerEngine` and its `AetherSurface` view (player core spec 6.2).

## Commands
- `pnpm --filter @elv/engine-aether typecheck` and `pnpm --filter @elv/engine-aether test` run TypeScript and Vitest checks.
- `swift test --package-path modules/engine-aether/ios` runs the pure Swift core suite (`ElvAetherCoreTests` on macOS).
- `sh modules/engine-aether/scripts/check-build.sh project|app|archive <path>` verifies the generated Xcode project, `.app` or `.xcarchive`.

## API & Threading (`src/index.ts`, `ios/Core/`, `ios/Engine/`)
- `createAetherEngine(): PlayerEngine | null` (`null` without `ElvEngineAether`) wraps a native `Engine` shared object (`EngineObject`) via `@elv/playback`'s `bridgeNativeEngine`; `release()` disposes it idempotently (`OnDestroy` and `sharedObjectDidRelease` also dispose live engines).
- `AetherSurface({ engine, style?, resizeMode?, testID? })` renders `AetherSurfaceView` bound to that native object (details in `VIEW.md`), or `null` when absent, foreign or released. `aetherEngineVersion()` returns `AetherEngine.version`.
- JS commands (`load`, `retry`, `play`, `pause`, `seek`, `stop`, `recreate`) lock a monotonic epoch + token in `EngineObject` and hop to `@MainActor` (`EngineMainDriver` -> `EngineCore` -> `AetherBackend`), fencing out superseded media events before `SharedObject.emit` (`onEngineEvent`, `atMs` from `ProcessInfo.processInfo.systemUptime * 1000`).
- `ios/Core/` imports `Foundation` only (`ElvAetherCore` + pod): `EngineCore` (token adoption, serial fencing, `firstFrame` before `playing`, 1 s clock throttle, shutter, screen-on, `surface-lost`), `MediaPlan`, `ErrorMapping`, `Redaction` and `StreamHttp`.

## Playback (`AetherBackend`, `AetherLoadOptions`)
- `AetherBackend` owns one `AetherEngine` (`backgroundPlaybackEnabled = false`), replaced on `recreate()`, subscribing once before its first load to `$startupProgress` (`.sourceOpened` -> `buffering`, `.ready` -> `ready`), `$playbackPhase`, `$hasFirstFrameReadyForDisplay`, `$videoRoute` (`.audio` -> `audioOnly`), `$state`/`$errorInfo`, `liveSourceReset` and `clock.$currentTime`/`$duration`.
- `stopMedia()` cancels the serial's load/seek `Task`s and calls `stop(resetDisplayCriteria: false, finalTeardown: false)`; `dispose()` calls `stop(resetDisplayCriteria: true, finalTeardown: true)` and unbinds the view. `seek` is ignored on live media.

## Rules & Build (`ios/ElvEngineAether.podspec`, `ios/embed-frameworks.sh`, `with-aether-frameworks.ts`)
- Imports `expo-modules-core` and `@elv/playback` only (`react`/`react-native` are view peers); source-first (`src/index.ts`). Never link MPVKit, VLCKit or a second FFmpeg copy; AetherEngine is pinned at exact `7.66.1` with optional traits off.
- `with-aether-frameworks.ts` appends `[ELV] Embed AetherEngine frameworks` as the app target's last phase (`post_integrate` keeps it last) and excludes `x86_64` on `appletvsimulator*`. `embed-frameworks.sh` copies, `lipo`-thins, signs and archives dSYMs for the nine dynamic LGPL `AetherLib*.framework` binaries (~11.0 MiB `tvos-arm64`).

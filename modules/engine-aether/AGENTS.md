# engine-aether (`@elv/engine-aether`)

Apple-only Expo module (tvOS, iOS, iPadOS): the AetherEngine 7.66.1 `PlayerEngine` and its surface view (player core spec 6.2).

## Commands
- `pnpm --filter @elv/engine-aether typecheck` type-checks this package.
- `pnpm --filter @elv/engine-aether test` runs its Vitest tests.
- `sh modules/engine-aether/scripts/check-build.sh project|app|archive <path>` verifies the generated Xcode project, `.app` or `.xcarchive`.

## API (`src/index.ts`)
- `createAetherEngine(): PlayerEngine | null` (`null` without `ElvEngineAether`) wraps a native `Engine` shared object via `bridgeNativeEngine`; `release()` frees it idempotently.
- `AetherSurface({ engine, style?, resizeMode?, testID? })` renders `AetherSurfaceView` bound to that native object, or `null` when absent, foreign or released. `aetherEngineVersion()` returns the linked AetherEngine version.

## Rules
- Layer rule (spec 5.2): imports `expo-modules-core` and `@elv/playback` only (`react`/`react-native` are view peers); only `apps/*` wire modules.
- Source-first: `exports` points at `src/index.ts` and `./package.json`; there is no TypeScript build step.
- Never link MPVKit, VLCKit or a second FFmpeg copy; AetherEngine stays pinned at exact `7.66.1` with optional package traits off.

## Build (`ios/ElvEngineAether.podspec`, `ios/embed-frameworks.sh`, `apps/tv-mobile/config/with-aether-frameworks.ts`)
- `ElvEngineAether.podspec` links `AetherEngine` `7.66.1` into the static module pod via React Native's `spm_dependency`.
- Because React Native 0.88.1's `spm_dependency` embeds nothing, `with-aether-frameworks.ts` adds `[ELV] Embed AetherEngine frameworks` as the app target's last build phase (kept last after `pod install` via `post_integrate`) and sets `EXCLUDED_ARCHS[sdk=appletvsimulator*] = x86_64` (LibDovi ships no x86_64 tvOS simulator slice).
- `embed-frameworks.sh` copies the nine dynamic LGPL `AetherLib*.framework` binaries without headers/modules, thins fat simulator slices to `$ARCHS` via `lipo`, signs when `CODE_SIGNING_ALLOWED=YES`, and copies their `.dSYM` bundles on `xcodebuild archive`.
- Device `tvos-arm64` framework sizes (~11.0 MiB total): `avcodec` 5.8M, `avformat` 1.1M, `swscale` 1.1M, `dav1d` 820K, `avutil` 776K, `zvbi` 524K, `avfilter` 504K, `zimg` 308K, `swresample` 144K.

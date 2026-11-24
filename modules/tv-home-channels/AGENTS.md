# tv-home-channels (`@elv/tv-home-channels`)

Android TV Expo module publishing bounded Home Screen Preview Channels (`Continue Watching` and `Favorites`, `#273`) via `TvContractCompat` and a private `FileProvider` logo cache.

## API (`src/index.ts`)
- `buildTvPlayDeepLink(itemKey, kind)`: returns strictly `elviptv://play?key=<encoded>&kind=<kind>` (never stream URLs or credentials).
- `isTvHomeChannelsSupported()`: synchronous check; `false` on web, Apple, non-Leanback, and Android `< API 26`.
- `syncTvHomeChannels(channels)`: pushes at most 2 channels (`continue_watching`, `favorites`), max 20 programs each; safe no-op where unsupported.
- `clearTvHomeChannels()`: deletes all app-owned channels and clears cached launcher logos; safe no-op where unsupported.

## Android native (`android/`)
- `ElvTvHomeChannelsModule.kt`: Expo Module (`ElvTvHomeChannels`) running sync/clear sequentially on a background `ExecutorService` (never blocks main thread).
- `TvChannelSecurity.kt`: pure JVM-testable deep-link builder, SSRF URL/IP guard (blocks private/loopback/link-local/CGNAT/ULA/multicast/SVG/userinfo), `image/*` MIME guard, and channel/program capping.
- `TvChannelLogoCache.kt`: bounded (`2 MiB`, `48` files) SHA-256 disk cache in `cacheDir/tv_channel_logos/` with manual redirect checks (`<= 2` hops), DNS rebinding IP validation, `FileProvider` URIs, and `FLAG_GRANT_READ_URI_PERMISSION` for Android TV launchers.
- `TvChannelsSyncManager.kt`: `TvContractCompat` sync respecting `COLUMN_BROWSABLE == 0` and SharedPreferences removal tombstones; calls `requestChannelBrowsable` once on initial default channel creation.

## Commands & Rules
- TS tests: `pnpm --filter @elv/tv-home-channels test`. Typecheck: `pnpm --filter @elv/tv-home-channels typecheck`.
- JVM tests: `APP_VARIANT=development EXPO_TV=1 ./gradlew.bat :elv-tv-home-channels:testDebugUnitTest`.
- Imports `expo-modules-core` only; Android-only native code (`platforms: ["android"]`). Source-first (`src/index.ts`).

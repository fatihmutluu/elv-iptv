# features (`@elv/features`)

Screens and view models, one folder per feature, with ports for platform services and root-level `AppShell`.

## Commands
- `pnpm --filter @elv/features typecheck` type-checks this package.
- `pnpm --filter @elv/features test` runs pure Vitest unit tests (`>= 90%` line coverage).
- `pnpm --filter @elv/features test:jest` runs Jest + RNTL component and simulator tests.
- `pnpm -w check` runs every repository check.

## Rules
- **UI/UX Contract & Feature Placement (mandatory):** Read `docs/design/UI_UX_PHILOSOPHY.md` before implementing any screen, overlay, player control, or new user-facing feature — place every feature strictly according to its Feature Placement Matrix (4+2 top-level cap, Live TV sub-modes for Channels/EPG, 2-level player Settings popover / Portrait bottom sheet, Detail order `Hero -> Cast -> Season Dropdown & Episodes -> More Like This`, and the 10-point Pre-Merge UI Checklist).
- Allowed workspace dependencies: `@elv/data`, `@elv/domain`, `@elv/focus-core`, `@elv/i18n`, `@elv/playback`, `@elv/ui-kit`.
- Never imports `modules/*`, `apps/*`, `expo-*`, navigation libraries or another feature's folder (`no-feature-to-feature`).
- Platform services (`PlaybackGuard`, `VideoHost`, `AppLifecyclePort`, `PlayTarget`) live under `src/ports/`.
- Source-first: `exports` points at `src/index.ts`; every focusable control carries a deterministic `testID` and `accessibilityLabel`.
- `src/AppShell.tsx` composes canonical 4+2 nav (`Home`, `Live`, `Movies`, `Series` + `Search`, `Settings` utilities), overlay `detailStack` (`DetailScreen`), and full-screen `PlayerScreen` via `AdaptiveNavShell` (`#13`, `#14`, `#98`, `#325`).
- `src/search/` owns instant Turkish-tolerant `SearchScreen`, `SearchChrome`, `SearchResultsSection`, `search-model`, `useCatalogSearch`, and `useTvSearchNavigation` (`#14`).
- `src/home/` owns flagship Cinema Quietude `HomeScreen`, `HomeHero`, `HomeRail`, `HomeSkeleton`, `home-model`, bounded `useHomeData` (Continue Watching, On Air Now, My List, Featured Movies/Series), and `useTvHomeNavigation` (`#14`).
- `src/live/` owns unified Cinema Quietude Live TV Hub: `LiveScreen`, `LiveChannelsGrid`, `LiveWatchStage`, `LiveZapDrawer`, `EpgGridView`, `EpgPreviewHeader`, `EpgChannelRow`, `LiveChrome`, `LiveNumberPad`, `live-model`, `useLiveCatalog`, `useEpgWindowData`, and `useTvLiveNavigation` (`#6`, `#13`, `#43`, `#44`, `#48`, `#54`, `#56`, `#250`).
- `src/catalog/` owns `CatalogDiscoveryScreen`, `CatalogCategoryRail`, `CategoryGridView`, `catalog-model`, `useCatalogDiscovery`, and `useTvCatalogNavigation` for Movies & Series discovery (`#14`).
- `src/detail/` owns 2-column `DetailScreen`, `DetailHero`, `DetailCastStrip`, `DetailEpisodes`, `DetailRelatedRail`, `detail-model`, `episode-chunks`, `useEpisodeChunks`, `useDetailData`, and `useTvDetailNavigation` (`#14`, `#152`).
- `src/shared/` owns cross-feature pure helpers (`DetailTarget`, `detailTargetFromItem`, `computeCatalogLayout`, `createPagedListSource`, `batchLoadProgressByKeys`, `buildSharedDisplayCategories`, `matchesWatchStatus`).
- `src/settings/` owns `SettingsScreen`, `AppearancePanel` (live Language `#16`, 6 Theme Presets including WCAG AAA High Contrast `#325`, Text Scale `#62`, Reduce Motion `#325`, Reset), `AboutLicensesPanel`, and `useTvSettingsNavigation` (10-ft TV D-pad sidebar/content focus handoff).
- `src/shell/` owns config-driven `AdaptiveNavShell` (`NavDestination`, `NavUtility`, Portrait bottom tabs / Landscape frosted top bar / TV D-pad traversal), TV-navigable `CrashRecoveryBoundary` (`#159` Reload / Clear UI Cache / Switch Source with redacted error reference), and root `AppProviders` + `usePreferences` (preferences hydration, live i18n locale switching without remount `#16`, theme sync, `TvRemoteProvider`, `ErrorBoundary`).
- `src/browse/` owns legacy `BrowseScreen`, `SeriesDetailPane`, and browse models (`#13`).
- `src/notices/` owns `ThirdPartyNoticesScreen` and generated `THIRD_PARTY_NOTICES` (`#98`).
- `src/player/` owns Cinema Quietude `PlayerScreen` (`usePlayerSession`, `usePlayerTargetHandoff`, `usePlayerControls`, `usePlayerOverlayState`, background stop, live zapping & previous-channel jump, VOD pause/step/hold-seek, touch-only lock, single-connection `NextEpisodeBanner` `#353`), `VodProgressBar`, `TrackPickerModal` (`#73`), 2-level `PlayerSettingsSheet` + `PlayerStatsHud`, and `describePlaybackFailure` (`#13`).
- `src/sources/` owns `SourcesScreen`, `useSourcesController`, `validateSourceForm`, and `describeSourceFailure` (`#71`).

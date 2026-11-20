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
- `src/AppShell.tsx` composes `Live`, `Movies`, `Series`, `Sources`, `Notices`, and `PlayerScreen` via `AdaptiveNavShell` (`#13`, `#98`).
- `src/shell/` owns config-driven `AdaptiveNavShell` (`NavDestination`, `NavUtility`, Portrait bottom tabs / Landscape frosted top bar / TV D-pad traversal) and root `AppProviders` + `usePreferences` (preferences hydration, live i18n locale switching without remount `#16`, theme sync, `TvRemoteProvider`, `ErrorBoundary`).
- `src/browse/` owns `BrowseScreen`, `SeriesDetailPane`, `createPagedListSource` (LRU-paged `ListSource`), and browse models (`#13`).
- `src/notices/` owns `ThirdPartyNoticesScreen` and generated `THIRD_PARTY_NOTICES` (`#98`).
- `src/player/` owns `PlayerScreen` (`useEffect` engine lifecycle, background stop, live channel zapping, VOD pause/step/hold-seek controls), `VodProgressBar` (`ClockAnchor` leaf extrapolation), `TrackPickerModal` + `formatTrackLabel` (`#73`), and `describePlaybackFailure` (`#13`).
- `src/sources/` owns `SourcesScreen`, `useSourcesController`, `validateSourceForm`, and `describeSourceFailure` (`#71`).

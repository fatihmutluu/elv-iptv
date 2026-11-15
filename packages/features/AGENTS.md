# features (`@elv/features`)

Screens and view models, one folder per feature, with ports for platform services.

## Commands
- `pnpm --filter @elv/features typecheck` type-checks this package.
- `pnpm --filter @elv/features test` runs pure Vitest unit tests (`>= 90%` line coverage).
- `pnpm --filter @elv/features test:jest` runs Jest + RNTL component and simulator tests.
- `pnpm -w check` runs every repository check.

## Rules
- Allowed workspace dependencies: `@elv/data`, `@elv/domain`, `@elv/focus-core`, `@elv/i18n`, `@elv/playback`, `@elv/ui-kit`.
- Never imports `modules/*`, `apps/*`, `expo-*`, navigation libraries or another feature's folder.
- Platform services (playback guard, video host, app lifecycle, storage, secure store) come in through ports (`src/ports/`).
- Source-first: `exports` points at `src/index.ts`; every focusable control carries a deterministic `testID` and `accessibilityLabel`.
- `src/sources/` owns `SourcesScreen`, `useSourcesController`, `validateSourceForm`, and `describeSourceFailure` (`#71`).
- `src/browse/` owns `createPagedListSource` (LRU-paged `ListSource` over `CatalogService.items`) and browse state models (`#13`).

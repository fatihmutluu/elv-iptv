# features (`@elv/features`)

Screens and view models, one folder per feature, with ports for platform services.

## Commands
- `pnpm --filter @elv/features typecheck` type-checks this package.
- `pnpm -w check` runs every repository check.

## Rules
- Allowed workspace dependencies: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`, `@elv/ui-kit`.
- Never imports `modules/*`, `apps/*`, `expo-*`, navigation libraries or another feature's folder.
- Platform services (storage, engine, keys, secure store) come in through ports defined here
  and are wired by each app.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Component tests use Jest with `jest-expo` and `@testing-library/react-native`
  (`*.test.tsx` beside the code), run through a `test:jest` script.

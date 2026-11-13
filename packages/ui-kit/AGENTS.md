# ui-kit (`@elv/ui-kit`)

React components for react-native and react-native-web, design tokens and TV focus primitives.

## Commands
- `pnpm --filter @elv/ui-kit typecheck` type-checks this package.
- `pnpm -w check` runs every repository check.

## Rules
- May import `react` and `react-native`; never `expo-*`, navigation libraries or `electron`.
- Allowed workspace dependencies: `@elv/domain`, `@elv/focus-core`, `@elv/i18n`.
- Never imports `features`, `modules/*` or `apps/*`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Layout forks (TV, phone, tablet, desktop) happen in a few container components chosen by an
  explicit form-factor value, never by file-name suffix.
- Component tests use Jest with `jest-expo` and `@testing-library/react-native`
  (`*.test.tsx` beside the component). With the first component, add a `test:jest` script
  and the Jest dev dependencies as in `apps/tv-mobile`; `pnpm check` runs it.

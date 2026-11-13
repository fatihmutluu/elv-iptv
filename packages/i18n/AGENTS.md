# i18n (`@elv/i18n`)

Lingui catalogs, ICU wrappers and polyfills. Keep it free of React for now.

## Commands
- `pnpm --filter @elv/i18n typecheck` type-checks this package.
- `pnpm --filter @elv/i18n test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Enforced (dependency-cruiser): workspace imports come from `@elv/domain` only.
- Conventions, not checked by a tool (i18n is not one of the five pure packages of spec 5.2):
  - Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
    Platform access goes through ports defined in `@elv/domain`.
  - Source-first: `exports` points at `src/index.ts`; there is no build step.
  - Tests live beside the code as `*.test.ts`.

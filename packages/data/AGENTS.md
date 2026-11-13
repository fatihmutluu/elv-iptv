# data (`@elv/data`)

Schema, migrations and repositories for catalog, EPG and user data, over the `SqlDriver` port.

## Commands
- `pnpm --filter @elv/data typecheck` type-checks this package.
- `pnpm --filter @elv/data test` runs its Vitest tests.
- `pnpm -w check` runs every repository check.

## Rules
- Pure TypeScript: no `react`, `react-native`, `expo*`, `electron` or `node:*` imports.
  Platform access goes through ports defined in `@elv/domain`.
- Source-first: `exports` points at `src/index.ts`; there is no build step.
- Allowed workspace dependencies: `@elv/domain` and `@elv/sources`.
- Tests live beside the code as `*.test.ts`.

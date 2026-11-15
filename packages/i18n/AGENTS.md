# i18n (`@elv/i18n`)

Pure TypeScript localization over `@lingui/core`: English (`en`) and Turkish (`tr`) `.po` catalogs, typed `AppI18n`, `resolveLocale`, and conditional `Intl.PluralRules` polyfill (`ensurePluralRules`). Keep it free of React (`I18nProvider` / `useI18n` live in `@elv/ui-kit`).

## Commands
- `pnpm --filter @elv/i18n typecheck` type-checks this package.
- `pnpm --filter @elv/i18n test` runs Vitest with `>= 90%` line coverage.
- `pnpm -w check` runs every repository check.

## Rules
- Enforced (`dependency-cruiser` + Biome): workspace imports come from `@elv/domain` only; no `react`, `react-native`, `expo*`, `electron`, `node:*`, or browser globals.
- Keep `locales/{en,tr}/messages.po` and `src/locales/{en,tr}.ts` in strict key and `{placeholder}` parity (`src/i18n.test.ts`).
- Source-first: `exports` points at `src/index.ts`; tests live beside the code as `*.test.ts`.

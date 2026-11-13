---
name: add-package
description: Creates a new workspace package (pure TypeScript, react-native UI, or Expo native module) with the repository's conventions. Use when the user or a plan asks for a new package under packages/ or modules/.
---

# Add a workspace package

Packages are source-first (`exports` points at `src/index.ts`, no build step) and follow the layer rules in
spec section 5.2 (`docs/superpowers/specs/2026-11-13-foundation-design.md`).

## Pick the kind
- `pure`: `packages/<name>/`, Vitest, no `react`, `react-native`, `expo*`, `electron` or `node:*`. Models, logic, ports.
- `rn`: `packages/<name>/`, may import `react` and `react-native` (versions from the pnpm `catalog:`), Jest component tests
  (the first component adds the `test:jest` script and Jest dependencies, as in `apps/tv-mobile`).
- `module`: `modules/<name>/`, Expo native module. The scaffold writes `expo-module.config.json` (platforms apple,
  android, web) and a TypeScript entry that returns `null` on web. It generates no Swift or Kotlin; add those and the
  `apple.modules` / `android.modules` config entries with the module's first native API.

## Steps
1. Choose a lower-case kebab-case `name` that does not exist yet. The package becomes `@elv/<name>`.
2. Run `pnpm scaffold <pure|rn|module> <name>`. It refuses to overwrite an existing folder and prints the files it wrote.
3. Fill in the generated `AGENTS.md` (keep it at 50 lines or fewer): one sentence of purpose, replace both `TODO`
   markers, state the allowed workspace dependencies from spec section 5.2. Its `CLAUDE.md` stays `@AGENTS.md`.
4. Add the dependencies the package really imports (`workspace:*` for workspace packages, `catalog:` for shared versions),
   then run `pnpm install`.
5. Check `.dependency-cruiser.cjs`: the folder name must be listed in the rule that governs it (`PURE` list and the
   `layer(...)` rules for packages, `^modules/` rules for modules). `tools/test/dependency-coverage.test.ts` fails for a
   package that no rule names, so extend the rule and add a fixture case in `tools/test/dependency-rules.test.ts`.
   A new pure package also goes into the `noRestrictedImports` override in the root `biome.json`.
6. Check `knip.ts`: if the package declares dependencies before any code imports them (skeleton), add a
   `workspaces['<dir>']` entry with `ignoreDependencies`, as the skeleton packages do. Remove it when code lands.
7. Write the first failing test, then the code. Pure packages need at least 90% line coverage.
8. Run `pnpm check` and fix every failure. Commit with a Conventional Commit title and a why-focused body.

## Do not
- Do not hand-create package folders; the scaffolder keeps manifests uniform.
- Do not add a `build` step or compiled `exports`.
- Do not import across layers to save time; add a port in `@elv/domain` instead.

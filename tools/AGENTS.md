# tools (`@elv/tools`)

TypeScript scripts for the repository: project checks, app launcher, bootstrap, scaffolder.
Node 24 runs the `.ts` files directly (type stripping), so use erasable syntax only
(no enums, no namespaces, no constructor parameter properties) and `.ts` import suffixes.

## Commands (run from anywhere; the repo root is found via `pnpm-workspace.yaml`)
- `pnpm check` runs every check and prints failures, notes and warnings (also on a passing run),
  plus `check: N passed, M failed`.
- `pnpm check --only <key>` runs one check. Keys: biome, typecheck, deps, knip, file-size,
  stubs, vitest, jest, gitleaks-rules, hooks. `--json` prints the report as JSON.
- From inside a workspace package folder use `pnpm -w check`.
- `pnpm bootstrap` checks versions, installs dependencies and git hooks, looks for gitleaks.
- `pnpm run:app <target> [build] [--production]` launches or builds a target.
  Targets: android, android-tv, fire-tv, ios, tvos, windows, macos, linux.
- `pnpm scaffold <pure|rn|module> <name>` creates a workspace package (skill `add-package`).
- `pnpm --filter @elv/tools test` runs this package's Vitest suite.

## Layout
- `src/` library modules, each unit-tested: `env`, `run-command`, `prebuild-stamp`, `scaffold`,
  `file-size`, `agents-stubs`, `runner`, `root`, `bootstrap`, plus `checks` (check definitions)
  and `exec`.
- `bin/` thin entry points that parse arguments and call `src/`.
- `test/` Vitest tests. Linked-workspace tests (`dependency-links.test.ts`) and fixture cases
  (`test/fixtures/<case>/`, tiny workspaces) prove the rules in `/.dependency-cruiser.cjs`;
  fixtures are excluded from Biome, tsc, knip and the real `deps` check.
  `dependency-coverage.test.ts` fails when a package has no rule of its own, and
  `biome-restricted-imports.test.ts` proves the Biome import ban for pure packages.

## Rules
- Dev credentials: `.env.local` is read by `run:app` only. `DEV_*` keys reach development
  builds through the environment, never argv, never production. Tests use temp files.
- A new architecture rule needs a fixture case in `test/dependency-rules.test.ts`.
- A new check goes into `src/checks.ts` and the key list above.
- Keep output quiet: no progress lines, no passing-check output.

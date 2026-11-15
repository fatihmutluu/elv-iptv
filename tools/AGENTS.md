# tools (`@elv/tools`)

TypeScript scripts for the repository: project checks, app launcher, bootstrap, scaffolder.
Node 24 type-strips `.ts`: erasable syntax only (no enums, namespaces, parameter properties), `.ts` import suffixes.

## Commands (run from anywhere; the repo root is found via `pnpm-workspace.yaml`)
- `pnpm check` runs every check, prints failures, notes and warnings (also when passing) and `check: N passed, M failed`; in a package folder use `pnpm -w check`.
- `pnpm check --only <key>` runs one check (keys: biome, typecheck, deps, knip, file-size, stubs, notices, vitest, jest, gitleaks-rules, hooks); `--json` prints JSON.
- `pnpm bootstrap` checks versions, installs dependencies and git hooks, looks for gitleaks.
- `pnpm run:app <target> [build] [--production]` launches or builds a target (android, android-tv, fire-tv, ios, tvos, windows, macos, linux).
- `pnpm gate list [flags]` runs the TV list gate on a running Android TV emulator; flags, baseline and budget rules: `src/gates/AGENTS.md`.
- `pnpm gate import [flags]` runs the on-device catalog import gate on the Android TV emulator; flags, baseline and budget rules: `src/gates/AGENTS.md`.
- `pnpm gate player [flags]` runs the player zap, fault, soak and stress gate on Android TV, tvOS and iOS simulators; flags, baselines and budget rules: `src/gates/AGENTS.md`.
- `pnpm gate contract [flags]` runs the shared `PlayerEngine` contract gate on Android TV, tvOS and iOS simulators; flags: `src/gates/AGENTS.md`.
- `pnpm gate desktop [flags]` runs the desktop mpv player zap, VOD, fault and orphan gate (Windows / macOS); flags, baseline and budget rules: `src/gates/AGENTS.md`.
- `pnpm mpv fetch [--force]` / `pnpm mpv verify [--dir <folder>]` install and rescan the pinned mpv runtime for desktop; builds the Windows `elv-mpv.exe` launcher; macOS gets our CI build (`mpv-runtime/`, workflow `mpv-runtime.yml`) through `gh`; rules: `src/mpv/AGENTS.md`.
- `pnpm scaffold <pure|rn|module> <name>` creates a workspace package (skill `add-package`).
- `pnpm ffmpeg-media3 fetch [--force]` and `pnpm ffmpeg-media3 verify [--dir <folder>]` install and verify the LGPL-2.1+ Android FFmpeg + Media3 JNI bundle (`modules/engine-media3/ffmpeg-media3.lock.json`, 16 KB ELF alignment, dynamic `DT_NEEDED`).
- `pnpm notices:sync` regenerates `packages/features/src/notices/notices-data.ts` from workspace runtime dependencies and native engine lock pins (`pnpm check --only notices` verifies freshness).
- `pnpm --filter @elv/tools test` runs Vitest (`sources-*`, `import-*` use the sim; `SIM_HUGE=1` adds 500k).

## Layout
- `src/` library modules, each unit-tested: `env`, `run-command`, `prebuild-stamp`, `scaffold`, `file-size`, `agents-stubs`,
  `runner`, `root`, `bootstrap`, `mpv/`, `ffmpeg-media3/`, `notices/`, `gates/` (gate runner), plus `checks` (check definitions) and `exec`.
- `bin/` thin entry points that call `src/`. `test/` holds the Vitest tests: linked-workspace tests
  (`dependency-links.test.ts`) and fixture cases (`test/fixtures/<case>/`, tiny workspaces) prove the rules in
  `/.dependency-cruiser.cjs`; fixtures are excluded from Biome, tsc, knip and the real `deps` check.
  `dependency-coverage.test.ts` fails when a package has no rule of its own; `biome-restricted-imports.test.ts` proves the Biome import ban.

## Rules
- Dev credentials: `.env.local` is read by `run:app` only; `DEV_*` keys reach development builds via env, never argv or production; tests use temp files.
- A new architecture rule needs a fixture case in `test/dependency-rules.test.ts`; a new check goes into `src/checks.ts` and the key list. Keep check output quiet: no progress or passing-check lines.

## Stream simulator (`pnpm sim`; `src/sim/`, built-ins only; plays an IPTV provider for the apps)
- `pnpm sim [--port 7878] [--host 127.0.0.1|0.0.0.0] [--seed 1] [--clock <ISO>] [--log <file>] [--prepare]`
  prints the URL (emulator: `http://10.0.2.2:<port>`); bind `0.0.0.0` only when asked.
- FFmpeg (`FFMPEG_PATH`, then PATH; none: media 503, media tests skip) caches media in `<repo>/.cache/sim-media/`;
  `--prepare` builds all recipes at full length, prints one line, exits 0.
- Streams, accounts (synthetic, password = username), data routes, faults, runtime fault rules (`/_sim/faults`) and
  recipes: [`docs/simulator.md`](../docs/simulator.md).

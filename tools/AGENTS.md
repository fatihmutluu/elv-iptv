# tools (`@elv/tools`)

TypeScript scripts for the repository: project checks, app launcher, bootstrap, scaffolder.
Node 24 type-strips `.ts`: erasable syntax only (no enums, namespaces, parameter properties), `.ts` import suffixes.

## Commands (run from anywhere; the repo root is found via `pnpm-workspace.yaml`)
- `pnpm check` runs every check and prints failures, notes and warnings (also on a passing run),
  plus `check: N passed, M failed`. From inside a workspace package folder use `pnpm -w check`.
- `pnpm check --only <key>` runs one check. Keys: biome, typecheck, deps, knip, file-size,
  stubs, vitest, jest, gitleaks-rules, hooks. `--json` prints the report as JSON.
- `pnpm bootstrap` checks versions, installs dependencies and git hooks, looks for gitleaks.
- `pnpm run:app <target> [build] [--production]` launches or builds a target.
  Targets: android, android-tv, fire-tv, ios, tvos, windows, macos, linux.
- `pnpm scaffold <pure|rn|module> <name>` creates a workspace package (skill `add-package`).
- `pnpm --filter @elv/tools test` runs Vitest (`sources-*`, `import-*` use the sim; `SIM_HUGE=1` adds 500k).

## Layout
- `src/` library modules, each unit-tested: `env`, `run-command`, `prebuild-stamp`, `scaffold`, `file-size`,
  `agents-stubs`, `runner`, `root`, `bootstrap`, plus `checks` (check definitions) and `exec`.
- `bin/` thin entry points that call `src/`. `test/` holds the Vitest tests: linked-workspace tests
  (`dependency-links.test.ts`) and fixture cases (`test/fixtures/<case>/`, tiny workspaces) prove the rules in
  `/.dependency-cruiser.cjs`; fixtures are excluded from Biome, tsc, knip and the real `deps` check.
  `dependency-coverage.test.ts` fails when a package has no rule of its own, and
  `biome-restricted-imports.test.ts` proves the Biome import ban for pure packages.

## Rules
- Dev credentials: `.env.local` is read by `run:app` only. `DEV_*` keys reach development
  builds through the environment, never argv, never production. Tests use temp files.
- A new architecture rule needs a fixture case in `test/dependency-rules.test.ts`.
- A new check goes into `src/checks.ts` and the key list above.
- Keep output quiet: no progress lines, no passing-check output.

## Stream simulator (`pnpm sim`; `src/sim/`, built-ins only; plays an IPTV provider for the apps)
- `pnpm sim [--port 7878] [--host 127.0.0.1|0.0.0.0] [--seed 1] [--clock <ISO>] [--log <file>] [--prepare]`
  prints the URL (emulator: `http://10.0.2.2:<port>`); bind `0.0.0.0` only when asked.
- FFmpeg (`FFMPEG_PATH`, then PATH; none: media 503, media tests skip) caches media in `<repo>/.cache/sim-media/`;
  `--prepare` builds all recipes at full length, prints one line, exits 0.
- Streams: VOD `/movie|series/<u>/<p>/<id>.mp4|mkv` (`Range`); live `/live/<u>/<p>/<id>.ts`, `/<u>/<p>/<id>`,
  `*/relative/<id>.ts` (FFmpeg loop, killed on disconnect); `.m3u8` (6x2 s window, `/hls/<recipe>/<seq>.ts`);
  `/redirect/<id>.ts` (302); catch-up (`/timeshift/...`, `/streaming/timeshift.php`, `/catchup/<id>.ts`,
  `archive-|index-|timeshift_abs-` paths) answers a plain recorded file.
  TS live and VOD over `maxConnections`: 509, 403 or a notice.
- Accounts (password = username): `demo` (small, 1 connection), `large` (2), `compat` (1), `expired`, `quirks`
  (real-panel shapes: CRLF playlist, +0100 guide), `huge` (500k entries, 2 connections; opt-in, not in `pnpm check`).
- Routes: `/get.php`, `/player_api.php`, `/xmltv.php`; `/playlists/<profile>[-variant].m3u|.m3u8`,
  `/playlists/broken/<status>.m3u`, `/guides/<profile>.xml[.gz]`, `/logos/<0-15>.png`, `/_sim/requests` (GET, DELETE),
  `/_sim/events` (GET, POST JSONL <= 1 MB). Log: passwords `***`.
- Faults: `?fault=<spec>`, parts joined by `,`: `status=<200-599>`, `slow-start=<s>`, `redirect`, `text-notice` (before
  any route), `drop@<s>`, `stall<n>s@<s>`, `rate=<kbps>`. Drop, stall and rate apply to TS and VOD responses only
  (not HLS segments or data routes). Unknown: 400. Catalog faults (1013, 1014) act like a query.

# gates (`tools/src/gates/`)

The TV list gate runner behind `pnpm gate list`.

- `pnpm gate list [--avd elv_tv] [--build] [--runs 3 (default)] [--real-keys 60] [--real-hold 2000] [--ci] [--baseline file] [--budgets fail|warn] [--out file] [--write-baseline]`
  runs the gate on a running Android TV emulator (adb from ANDROID_HOME, the default SDK or PATH).
- `--real-hold <ms>`: API 33+, holds Down once, moves must match the interpreter +-3.
- Compares the median with `docs/learned/gates/list-android-tv.json` (or `--baseline`; a missing given file: budgets and
  losses only, warned; spec 5.6).
- Writes the median and every run to `--out` (default `gate-list.json`, with `--ci` under `gate-artifacts/`).
- Warns when the worst run breaks a budget the median meets; exits 1 on a failure.
- `--budgets warn` (CI) only warns about absolute budgets; with it `--write-baseline` refuses the local baseline and
  needs another `--baseline` file.

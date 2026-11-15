# gates (`tools/src/gates/`)

The gate runners behind `pnpm gate list`, `pnpm gate import`, `pnpm gate player` and `pnpm gate desktop`.

- `pnpm gate list [--avd elv_tv] [--build] [--runs 3 (default)] [--real-keys 60] [--real-hold 2000] [--ci] [--baseline file] [--budgets fail|warn] [--out file] [--write-baseline]`
  runs the gate on a running Android TV emulator (adb from ANDROID_HOME, the default SDK or PATH).
- `--real-hold <ms>`: API 33+, holds Down once, moves must match the interpreter +-3.
- Compares the median with `docs/learned/gates/list-android-tv.json` (or `--baseline`; a missing given file: budgets and
  losses only, warned; spec 5.6).
- Writes the median and every run to `--out` (default `gate-list.json`, with `--ci` under `gate-artifacts/`).
- Warns when the worst run breaks a budget the median meets; exits 1 on a failure.
- `--budgets warn` (CI) only warns about absolute budgets; with it `--write-baseline` refuses the local baseline and
  needs another `--baseline` file.
- `pnpm gate import [--avd elv_tv] [--build] [--account large|huge] [--batch 5000] [--max-body 4096] [--runs 3 (default)] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]`
  starts the simulator on 127.0.0.1:7878 (or reuses a running one), opens `elviptv://gate/import` on the emulator (host `10.0.2.2:7878`) `--runs` times, compares the median with `docs/learned/gates/import-android-tv.json`: rows equal, duration +10 % (+2 s), stall under 100 ms (`large` only; `huge` is report-only, #76). Only `large` becomes a baseline.
- `pnpm gate player [--avd elv_tv] [--build] [--runs 3 (default)] [--zaps 30] [--faults] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]` needs FFmpeg; zap runs (median of times, worst run of counters and overlap, a warning for a time one run missed; budgets per spec 7) and `--faults` runs (drop5, 404, 509 at rate 0.1, slowstart zapped after 0.8 s; windows and limits from the simulator log, cleared after a force-stop and read after another one) against `docs/learned/gates/player-android-tv.json`; `--write-baseline` needs `--faults`.
- `pnpm gate desktop [--build] [--runs 3 (default)] [--zaps 30] [--faults] [--sim url] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]` starts an ephemeral local simulator (or uses `--sim <url>`) over healthy `h264-aac-720p25` channels + MP4 VOD seek, checks budgets (`videoVisible: null` warns, `false` fails), runs `--faults` (`drop5`, `404`, `509`, `notice`, `stall`, `slowstart`, `silent`) plus the orphan check (kills Electron main PID at first `playing`, expects stream close `<= 2,000 ms`), and compares with `docs/learned/gates/player-desktop-windows.json` or `player-desktop-macos.json`.

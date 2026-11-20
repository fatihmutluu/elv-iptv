# gates (`tools/src/gates/`)

The gate runners behind `pnpm gate list`, `pnpm gate import`, `pnpm gate player`, `pnpm gate contract`, `pnpm gate corpus` and `pnpm gate desktop`.

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
- `pnpm gate player [--target android-tv|tvos|ios] [--avd elv_tv] [--build] [--app <.app>] [--device <name>] [--channels 1001,1002,...] [--stream ts|hls|vod] [--rate 0.5] [--burst 0] [--soak <min>] [--stress] [--runs 3 (default)] [--zaps 30] [--faults] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]` runs zap, fault (`drop5,404,509,slowstart,silent` + Apple `notice,stall`), soak (`--soak`, memory + position) or stress (`3 x 200` at `5/s`) runs against `docs/learned/gates/player-<android-tv|tvos-sim|ios-sim>.json`; `--burst <s>` (`0-30 s`) adds a live TS initial burst (Apple burst > 0 uses spec 7 budgets, burst 0 uses `4/3/4 s` realtime ceilings); FFmpeg is required only when starting a local simulator; `--write-baseline` needs `--faults`.
- `pnpm gate contract [--target android-tv|tvos|ios] [--avd elv_tv] [--build] [--app <.app>] [--device <name>] [--out file]` opens `elviptv://gate/contract` and waits `<= 180 s` for `ELV_GATE_CONTRACT`.
- `pnpm gate corpus [--target android-tv|fire-os|android|tvos|ios|desktop] [--avd <name>] [--build] [--app <.app>] [--device <name>] [--burst <0..30>] [--sim <url>] [--out <file>]` (also `pnpm gate player --corpus` and `pnpm gate desktop --corpus`; `--sim` is desktop-only) sweeps all 29 items of the simulator's `corpus` profile (`ELV_GATE_CORPUS`) and checks `surfaceCreated === 1`, `staleEventsApplied === 0`, `limitResponses === 0`, `overlapMs === 0` (plus desktop `mpvSpawns === 1` and `videoVisible !== false`).
- `pnpm gate desktop [--build] [--runs 3 (default)] [--zaps 30] [--faults] [--sim url] [--baseline file] [--budgets warn|fail] [--out file] [--write-baseline]` starts an ephemeral local simulator (or uses `--sim <url>`) over healthy `h264-aac-720p25` channels + MP4 VOD seek, checks budgets (`videoVisible: null` warns, `false` fails), runs `--faults` (`drop5`, `404`, `509`, `notice`, `stall`, `slowstart`, `silent`) plus the orphan check (kills Electron main PID at first `playing`, expects stream close `<= 2,000 ms`), and compares with `docs/learned/gates/player-desktop-windows.json` or `player-desktop-macos.json`.

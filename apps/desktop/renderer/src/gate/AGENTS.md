# Desktop player gate (`renderer/src/gate/`)

Dev-only driver that measures the real mpv engine against `pnpm sim`; `pnpm gate desktop` (Task 13) parses its line.
Read `apps/desktop/AGENTS.md` and `src/main/player/AGENTS.md` first.

## Launch
- `pnpm --filter @elv/desktop run prepare:app`, then `electron . "--elv-gate=elv-gate=player&base=http://127.0.0.1:7880&account=demo&channels=1001,1004&zaps=30&rate=0.5&vod=200001&fault="`
  (`fault`: `drop5`, `404`, `509`, `notice`, `stall` = `stall30s@2s`, `silent` = `stall30s@0s`, `slowstart` = `slow-start=3`; `zaps` 1..200, `rate` 0.05..5 per s, 20 channels at most, `base` a
  loopback, RFC 1918 or RFC 6598 Tailscale `http://` address). `parseGateFlag` (`src/main/gate.ts`) ignores the flag in packaged builds. Main also prints `ELV_GATE_PLAYING` once on the first `playing` state for the orphan check.
- A gate launch uses `<temp>/elv-gate` as user-data folder (wiped at start): the single-instance lock lives in the
  user-data folder, so a gate or e2e launch next to an open dev instance would otherwise quit at once. Two gates at the
  same time still collide, on purpose. Main quits after it printed the line.
- The query goes to the renderer as `app://elv/?<query>`; `App.tsx` shows `GateScreen` only when the preload's
  `window.elv.gate` is true (main adds `--elv-gate-mode` to the window in gate mode; `resolveGate`).

## The line: one `ELV_GATE_PLAYER {json}` per run, never a stream URL or header
- Renderer: `ttffColdMs`, `ttffWarmMs`, `zapMs`, `surfaceCreated`, `staleEventsApplied`, `staleEventsDropped`,
  `failures`, `engineWedged`, `recoveries`, `fault`, `faultOutcome`, `zaps`, `vod {playing, seeked}` (`null` without
  `vod=`). Cold: first tune to first frame; warm: later tunes; zap: driver dispatch to first frame.
- Main adds `mpvSpawns`, `loadMode`, `presenter`, `videoVisible`, `distinct` (one capture of the window's middle half,
  1,000 ms after the first `firstFrame`; `null` when the capture has no image; it samples the engine's last area, else the middle half) and `coalesceMaxMs` (longest wait of a
  load for the previous one to open, from `MpvEngine.maxHoldMs`). `mergeGateLine` refuses a line with `http(s)://`.
- Run: live zaps, wait for the last tune to settle (15 s at most), then VOD (tune, playing, pause 1 s, play, seek to
  60 s, playing near 60 s). The recorder sees the live part only. A zap away from a stalled or slow-starting stream
  shows as `engineWedged` 0 and a small `coalesceMaxMs`.
- Outcomes: `recovered`, `failed-in-time`, `limited-backoff`, `left` (zapped away before the faulted channel played, the
  expected result of `slowstart`), `missed`. `stall` events of the current attempt feed rung-0 recovery.
- Pure and at 90 % lines: `params.ts`, `metrics.ts`, `driver.ts`, `corpus-driver.ts` (no `electron`, no `node:*`). `--elv-gate=elv-gate=corpus&...` (or `corpus=1`) runs the 29-item format corpus sweep and prints `ELV_GATE_CORPUS {json}`.

## Differences from the Android gate (`apps/tv-mobile/src/gate/player/`)
- `metrics.ts` is a copy of `player-metrics.ts` on purpose, because another branch is changing the Android file. The
  desktop adds `engineWedged` (an `engine-wedged` error must stay 0 when zapping from a stalled stream), a `vod` result
  and the fault `notice`; main adds `mpvSpawns`, `loadMode`, `presenter`, `videoVisible`, `distinct`, `coalesceMaxMs`.
- Plan: once both branches are merged, move the recorder, parameter clamps and zap driver into one shared package and
  keep only the platform parts (query vs deep link, base URL vs host) here.

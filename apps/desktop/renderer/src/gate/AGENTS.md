# Desktop player gate (`renderer/src/gate/`)

Dev-only driver that measures the real mpv engine against `pnpm sim`; `pnpm gate desktop` (Task 13) parses its line.
Read `apps/desktop/AGENTS.md` and `src/main/player/AGENTS.md` first.

## Launch
- `pnpm --filter @elv/desktop run prepare:app`, then `electron . "--elv-gate=elv-gate=player&base=http://127.0.0.1:7880&account=demo&channels=1001,1004&zaps=30&rate=0.5&vod=200001&fault="`
  (`fault`: `drop5`, `404`, `509`, `notice`; `zaps` 1..200, `rate` 0.1..5 per s, 20 channels at most, `base` a
  loopback or private `http://` address). `parseGateFlag` (`src/main/gate.ts`) ignores the flag in packaged builds.
- A gate launch uses `<temp>/elv-gate` as user-data folder (wiped at start): the single-instance lock lives in the
  user-data folder, so a gate or e2e launch next to an open dev instance would otherwise quit at once. Two gates at the
  same time still collide, on purpose. Main quits after it printed the line.
- The query goes to the renderer as `app://elv/?<query>`; `App.tsx` shows `GateScreen` for `elv-gate=player`.

## The line: one `ELV_GATE_PLAYER {json}` per run, never a stream URL or header
- Renderer: `ttffColdMs`, `ttffWarmMs`, `zapMs`, `surfaceCreated`, `staleEventsApplied`, `staleEventsDropped`,
  `failures`, `engineWedged`, `recoveries`, `fault`, `faultOutcome`, `zaps`, `vod {playing, seeked}` (`null` without
  `vod=`). Cold: first tune to first frame; warm: later tunes; zap: driver dispatch to first frame.
- Main adds `mpvSpawns`, `loadMode`, `presenter`, `videoVisible`, `distinct` (one capture of the window's middle half,
  1,000 ms after the first `firstFrame`; `null` when the capture has no image) and `coalesceMaxMs` (longest wait of a
  load for the previous one to open, from `MpvEngine.maxHoldMs`). `mergeGateLine` refuses a line with `http(s)://`.
- Run: live zaps, wait for the last tune to settle (15 s at most), then VOD (tune, playing, pause 1 s, play, seek to
  60 s, playing near 60 s). The recorder sees the live part only. A zap away from a stalled or slow-starting stream
  shows as `engineWedged` 0 and a small `coalesceMaxMs`.
- Pure and at 90 % lines: `params.ts`, `metrics.ts`, `driver.ts` (no `electron`, no `node:*`).

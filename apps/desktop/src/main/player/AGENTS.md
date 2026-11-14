# Desktop player engine (`src/main/player/`)

`engine.ts` (`createMpvEngine`) is the desktop `PlayerEngine`: one mpv process per player window, kept across zaps,
over the JSON IPC client (`mpv/`) and a `VideoPresenter` (`presenter/`). Read `apps/desktop/AGENTS.md` first.

## Rules
- Commands queue in order and return at once; nothing awaits mpv. One `loadfile` is in flight: its entry id comes
  from the reply (`playlist_entry_id`, mpv 0.42.0; else `get_property playlist/0/id`) and is bound to the token before
  the next command goes out. A `start-file` that beats the reply belongs to the loadfile in flight (measured).
- Zap coalescing (controller ruling): a `load` waits until the last sent one got its `start-file` and then
  `file-loaded` or its `end-file`; newer loads replace the waiting one, which never reaches mpv; `stop` and `release`
  clear it. No `start-file` in 3 s is `engine-wedged`; after `start-file` the wait ends after 1 s at most (slow open).
  `start-file` alone is too early: mpv sends it 1-22 ms after the reply, before connecting (measured).
- Only the newest media emits: a replaced or stopped media is silent at once, so nothing follows `stop`.
- A newer token on any other command tags the media's later events, also before its `start-file`.
- mpv keeps `pause` across files: after a `load`'s loadfile the engine sends `set pause no` when mpv is paused, and a
  file that starts while mpv is paused is derived as paused.
- Log lines are requested at `v`: mpv logs a provider notice's `Mime-type: 'text/plain'` only there (at `warn` the
  notice classifies as `unsupported-format`, measured). Only `fatal`, `error`, `warn`, `info` and `Mime-type:` lines
  reach the deriver, so its 50-line window per media keeps the classifier's signals.
- `engine-wedged` with the current token: no reply in 3 s (the process is killed), the IPC closing on its own, a
  failed spawn, or `stop-then-load` without the old `end-file` in 3 s. With the own-window presenter an exit after an
  unrequested `end-file reason=quit` is `player:ui` `closed` instead. The next `load` or `retry` respawns; `recreate`
  quits (kill after 500 ms) and respawns with the same presenter.
- `release` aborts a pending spawn (a process that still arrives is killed), quits mpv, disposes the presenter and
  emits nothing afterwards. `elv-key fullscreen` toggles the presenter; other `elv-key` names become `player:ui` keys.
- Recording launcher pids for the startup sweep is the spawner's job (`spawnMpv({ pidFile })`).

## IPC (renderer proxy)
- `ipc.ts` (`registerPlayerIpc`) serves `player:open|close|command|area` (+ dev `gate:report`). One engine per webContents (a
  second open releases the first); other senders' messages are dropped. A main-frame navigation, a renderer crash or
  `destroyed` releases it. Payloads pass the guards in `shared/player-ipc.ts`; a drop or a throw logs the channel only.
- `factory.ts` builds the engine with `deferStart`: `ipc.ts` subscribes, then calls `engine.start()`, so the first
  `surface created` (the video window is kept across zaps) reaches the renderer. `main.ts` takes the single-instance
  lock, then sweeps leftover launchers; packaged builds drop the default menu (Ctrl+R would reload).
- Main stamps events with `Date.now()`; the proxy (`renderer/src/player/desktop-engine.ts`) maps `atMs` with the open
  handshake offset, holds events until the first `subscribe` and replays the `presenter` ui event to late listeners.
- The renderer's dev gate (`renderer/src/gate/AGENTS.md`) reads `engine.spawns`, `loadMode`, `presenterKind` and `maxHoldMs`
  (longest coalescing wait) through `registerPlayerIpc`'s `gateReport(line, engine)`. mpv's idle logo (an OSC feature)
  cannot be switched off at runtime (`set script-opts`, `change-list`, `script-message` measured: no effect), and
  `--script-opts=osc-idlescreen=no` is not in the fixed launch options, so `PlayerView` keeps the area hidden until
  the first frame.

## Tests
- `engine.test.ts` drives the engine against `mpv/fake-mpv.ts` (a scripted mpv on a real named pipe or Unix socket).
  `engine.contract.test.ts` runs `ENGINE_CONTRACT_CASES` over FakeMpv and, with `ELV_MPV_SPIKE=1` and `ELV_SIM_URL`,
  over the real runtime and the simulator (one mpv window per case, about 35 s). `engine.ts` stays at 90 % lines.
- Measured (mpv 0.42.0, 2026-11-14), ten loads 18 ms apart on a playing channel: with coalescing 2 `loadfile`s and
  2 simulator requests; gated on `start-file` alone 10 and 6; always one connection at a time and no 509.

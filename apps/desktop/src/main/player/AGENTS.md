# Desktop player engine (`src/main/player/`)

`engine.ts` (`createMpvEngine`) is the desktop `PlayerEngine`: one mpv process per player window, kept across zaps,
over the JSON IPC client (`mpv/`) and a `VideoPresenter` (`presenter/`). Zero `electron` imports live inside
`engine.ts`, `engine-queue.ts` or `mpv/*`. Read `apps/desktop/AGENTS.md` first.

## Module layout
- `engine.ts`: lean orchestrator composing `EngineQueue`, `OpeningGate`, `LiveSession` (`mpv/live-session.ts`),
  `TrackTracker` and `VideoPresenter`.
- `engine-queue.ts`: generation-tagged serialized async op queue (`load`, `command`, `stop`, `recreate`) that purges
  queued `load` and `command` ops whenever superseded by `load`, `stop` or `recreate`.
- `power-blocker.ts`: reference-counted `prevent-display-sleep` guard wired by `ipc.ts` / `main.ts` to active
  `'playing'` state and released on `paused`, `ended`, `error`, `stop`, `release` or renderer crash.
- `factory.ts`, `ipc.ts`, `runtime-path.ts`: Electron composition, fenced `WebContents` IPC, and bundled mpv lookup.
- `mpv/live-session.ts`: per-process mpv event wiring, playlist entry binding, `Deriver` + `AudioHotplug` composition,
  and `stop-then-load` / clean-exit handling.
- `mpv/codec.ts` & `mpv/client.ts`: control-char-sanitized, 4 MiB-bounded JSON-line decoder and 3 s `MpvWedgedError`
  request/event IPC client.
- `mpv/process.ts`, `mpv/process-darwin.ts`, `mpv/pid-sweep.ts`: Windows named-pipe / Linux Unix-socket / macOS `fd://3`
  launchers (`LC_NUMERIC=C` on POSIX), `SIGKILL` escalation with bounded post-kill wait, and safe `tasklist` / `ps`
  leftover launcher sweep.
- `mpv/opening-gate.ts`: zap-coalescing state machine (`START_TIMEOUT_MS = 3000`, `OPEN_WAIT_MS = 1000`, `maxHoldMs`).
- `mpv/audio-hotplug.ts`: 500 ms debounced `audio-device-list` watcher queueing `ao-reload` on active media.
- `mpv/input-repeat-gate.ts`: per-key hold and auto-repeat limiter (`LONG_HOLD_MS = 350`, `AUTOREPEAT_MS = 160`, 600 ms idle reset) gating repeatable `elv-key` `client-message` events before `onUi`.
- `mpv/options.ts`: hardened `LAUNCH_OPTIONS` (`--reset-on-next-file=...`, `--tls-verify=yes`, `--audio-fallback-to-null=yes`,
  `--stream-lavf-o=icy=0`, diskless cache), case-insensitive deduplicated & control-char-stripped headers, and `loadfile`.
- `mpv/derive.ts`, `mpv/entries.ts`, `mpv/tracks.ts`, `mpv/track-snapshot.ts`, `mpv/errors.ts`, `mpv/redact.ts`:
  state/clock derivation (`playback-time` with `time-pos` fallback, post-`file-loaded` audio-only `vid` guard, late VOD
  `duration` anchor), playlist entry binding, ISO 639-1/639-2/BCP-47 track reconciliation (`sid="no"` latch safety),
  HTTP/TLS/decoder `end-file` classification, and strict allowlist URL/secret redaction.

## Rules
- Commands queue in order through `EngineQueue` and return at once; nothing awaits mpv synchronously, including
  `tracks.reconcileCommands()` and `ao-reload`. One `loadfile` is in flight: its entry id (`playlist_entry_id` or
  `playlist/0/id`) is bound to the token before the next command goes out.
- Zap coalescing (`OpeningGate`): a `load` waits until the last sent one got its `start-file` and then `file-loaded` or
  its `end-file`; newer loads replace the waiting one and purge queued transient commands; `stop` and `release` clear it.
  No `start-file` in 3 s is `engine-wedged`; after `start-file` the wait ends after 1 s at most (slow open).
- Only the newest media emits: a replaced or stopped media is silent at once, so nothing follows `stop`.
- `selectAudioTrack` / `selectSubtitleTrack` adopt the token only after validating the track ID command.
- Log lines are requested at `v` so `Mime-type: 'text/plain'` provider notices reach `classifyEnd`; `keepLog` filters
  the 50-line per-media buffer to `fatal`, `error`, `warn`, `info` and `Mime-type:` lines.
- Main and `factory.ts` stamp events with monotonic `performance.now()`, matching the renderer's `performance.now()`
  handshake offset in `renderer/src/player/desktop-engine.ts`.

## Tests
- `engine.test.ts`, `engine-tracks.test.ts`, `engine-headers.test.ts` and `engine-input-throttle.test.ts` drive `createMpvEngine` against `mpv/fake-mpv.ts`
  (which honors `--reset-on-next-file` rather than resetting `aid`/`sid` unconditionally).
- `engine.contract.test.ts` runs `ENGINE_CONTRACT_CASES` over `FakeMpv` and, with `ELV_MPV_SPIKE=1` and `ELV_SIM_URL`,
  over the real runtime and simulator. Keep line coverage >= 90 %.

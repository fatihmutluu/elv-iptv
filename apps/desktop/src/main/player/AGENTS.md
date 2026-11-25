# Desktop player engine (`src/main/player/`)

`engine.ts` (`createMpvEngine`) is the desktop `PlayerEngine`: one mpv process per player window, kept across zaps,
over the JSON IPC client (`mpv/`) and a `VideoPresenter` (`presenter/`). Zero `electron` imports live inside
`engine.ts`, `engine-queue.ts` or `mpv/*`. Read `apps/desktop/AGENTS.md` first.

## Module layout
- `engine.ts` & `engine-controls.ts`: orchestrator composing `EngineQueue`, `OpeningGate`, `LiveSession`,
  `TrackTracker`, speed coalescing, 175 ms play/pause audio ramp (`mpv/audio-ramp.ts`), `setHwdec` / property setters, labeled `vf`/`af` filters (`setDeinterlaceMode` `'off'|'auto'|'bwdif'` via `@elv_deint`, `setPitchLock` via `audio-pitch-correction`, `setAudioNormalization` via `@elv_loudnorm` with S/PDIF passthrough and `@ac3:lavcac3enc` suppression, `#243`, `#213`), desktop audio passthrough/exclusive/AC3-encode/layout with automatic AO-error safe PCM fallback (`mpv/audio-output.ts`, `#213`), `video-sync=display-resample` AFR policy (`#214`, `#116`), gapless VOD `append-play` queue (`queueNext`/`clearQueue`/`queueAdvanced` with `--prefetch-playlist=no` and custom-header match guard, `#205`), and `VideoPresenter`.
- `display-refresh.ts`: pure same-resolution fullscreen refresh-rate selector (`selectDesktopRefreshMode`, exact match `<= 0.15 Hz` then `2x..5x` integer multiple) and `createDesktopDisplayRefreshController` with injectable OS adapter (safe no-op fallback) guaranteeing original display mode restore on stop, exiting fullscreen, window close, engine release, and `will-quit` (`#214`, `#116`).
- `engine-queue.ts`: generation-tagged serialized async op queue (`load`, `command`, `stop`, `recreate`) that purges
  superseded `load`/`command` ops on `load`, `stop` or `recreate`.
- `power-blocker.ts`: reference-counted `prevent-display-sleep` guard wired in `ipc.ts`/`main.ts` to `'playing'`,
  released after a 30 s buffering-stall grace timeout (re-acquired on `'playing'`) and on `paused`/`ended`/`error`/`stop`/`release`/crash.
- `factory.ts`, `ipc.ts`, `ipc-commands.ts`, `runtime-path.ts`: Electron composition, fenced `WebContents` IPC + command dispatcher, and bundled mpv lookup.
  On macOS, `runtime-path.ts` exposes optional `canvasExecutable` (`ELV IPTV Player.app/Contents/MacOS/elv-mpv`) and
  `ioSurfaceAddon` (`elv-iosurface.node`) when both exist; `factory.ts` defaults macOS to `'canvas'` with
  `renderContext: true` when present and falls back cleanly to `'own-window'` (standalone `mpv`) when absent or overridden.
- `presenter/canvas.ts`, `presenter/iosurface.ts`, `presenter/choose.ts`, `presenter/create.ts`: out-of-process in-canvas
  shared-texture presenter (`#95`, default on Windows and macOS): uses an exclusive Windows named pipe (`ntHandle`) on
  `win32` or a `0o700`-dir/`0o600` Unix domain socket + cached `process.dlopen` `elv-iosurface.node` (`IOSurfaceLookup` /
  `CFRelease` in `finally`) on `darwin`, sending `I`/`A` acks and cleaning up the socket dir on dispose.
- `mpv/live-session.ts` & `mpv/session-constants.ts`: per-process mpv event wiring, entry binding, `Deriver` + `AudioHotplug` + `ReadaheadController`, and `stop-then-load` / clean-exit handling.
- `mpv/audio-ramp.ts` & `mpv/readahead.ts`: cancellable 7-step / 175 ms play/pause volume ramp with echo suppression;
  adaptive 3-tier (`fast` 2s / `normal` 8s / `aggressive` 20s) `demuxer-readahead-secs` controller + URL-free SHA-256 host+path 500-entry LRU store.
- `mpv/codec.ts` & `mpv/client.ts`: control-char-sanitized, 4 MiB-bounded JSON-line decoder and 3 s `MpvWedgedError` IPC client.
- `mpv/process.ts`, `mpv/process-darwin.ts`, `mpv/pid-sweep.ts`: Windows pipe / Linux socket / macOS `fd://3` launchers
  (`LC_NUMERIC=C` on POSIX), `SIGKILL` escalation with bounded wait, and safe `tasklist`/`ps` leftover sweep.
- `mpv/opening-gate.ts`: zap-coalescing state machine (`START_TIMEOUT_MS = 3000`, `OPEN_WAIT_MS = 1000`, `maxHoldMs`).
- `mpv/audio-hotplug.ts`: 500 ms debounced `audio-device` + `audio-device-list` watcher queueing `ao-reload` only when active output changes or flips presence.
- `mpv/input-repeat-gate.ts` & `mpv/render-coalescer.ts`: per-key hold/repeat limiter (`350`/`160` ms) and atomic render-wakeup coalescer.
- `mpv/options.ts`: hardened `LAUNCH_OPTIONS` (`--osc=no`, `--osd-level=0`, `--input-default-bindings=no`, `--demuxer-lavf-probe-info=yes`,
  expanded `--reset-on-next-file`, `--tls-verify=yes`, `--stream-lavf-o=icy=0,reconnect=1,...`), parameterized `hwdec`/platform args, headers, `loadfile`.
- `mpv/derive.ts`, `mpv/entries.ts`, `mpv/tracks.ts`, `mpv/track-snapshot.ts`, `mpv/errors.ts`, `mpv/redact.ts`:
  state/clock derivation, playlist entry binding, ISO 639-1/639-2/BCP-47 track reconciliation, HTTP/TLS/decoder `end-file` classification, and strict URL/secret redaction.

## Rules
- Commands queue in order through `EngineQueue` and return at once; nothing awaits mpv synchronously (`tracks.reconcileCommands()`, `ao-reload`). One `loadfile` is in flight: its entry id binds before the next command.
- Zap coalescing (`OpeningGate`): `load` waits for `start-file` then `file-loaded`/`end-file`; newer loads purge queued transient commands; `stop`/`release` clear it. 3 s start timeout -> `engine-wedged`; 1 s open cap.
- Only the newest media emits; `selectAudioTrack`/`selectSubtitleTrack` adopt the token only after command validation.
- Log lines run at `v` so `Mime-type: 'text/plain'` notices reach `classifyEnd`; `keepLog` keeps 50 filtered lines/media.
- Main and `factory.ts` stamp events with monotonic `performance.now()`, matching `renderer/src/player/desktop-engine.ts`.

## Tests
- `engine.test.ts`, `engine-ramp-readahead.test.ts`, `engine-tracks.test.ts`, `engine-headers.test.ts` and `engine-input-throttle.test.ts` drive `createMpvEngine` against `mpv/fake-mpv.ts` (honoring `--reset-on-next-file`).
- `engine.contract.test.ts` runs `ENGINE_CONTRACT_CASES` over `FakeMpv` and, with `ELV_MPV_SPIKE=1` + `ELV_SIM_URL`, over the real runtime. Keep line coverage >= 90 %.

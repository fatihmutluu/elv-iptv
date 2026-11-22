# desktop (`@elv/desktop`)

Electron shell for Windows, macOS and Linux. The UI is `renderer/` (`@elv/desktop-renderer`), an Expo web app rendered by react-native-web.

## Commands
- `pnpm dev:ui` (`scripts/dev-ui.mjs`) runs the browser UI Workbench (`http://localhost:8081`) with its loopback bridge (`src/dev/`); `pnpm dev:desktop` (`scripts/dev-hot.mjs`) runs Metro + unpackaged Electron (`ELV_DEV_SERVER_URL`).
- `pnpm run:app windows|macos|linux run|build` calls `dev`/`build`; `prepare:app` fetches mpv (`mpv-runtime.lock.json`), exports `renderer/`, and bundles main, preload + utility worker; `build` runs `electron-builder --publish never`.
- `test` runs Vitest (`pnpm check`); `test:e2e` runs Playwright (`app`, `catalog`, `packaged` over CDP, `player`, opt-in `presenter`). `pnpm gate desktop` runs the zap/fault/orphan gate (`renderer/src/gate/AGENTS.md`).

## Rules
- `package.json` `main` is the bundled main process; the Expo entry lives only in `renderer/`.
- The renderer loads from `app://elv/` via `protocol.handle`; `resolveAppFile` refuses paths outside `dist/renderer`. Keep CSP in `app-protocol.ts`, `contextIsolation`/`sandbox`/`!nodeIntegration`, and CommonJS preload.
- IPC channels and runtime guards live in `src/shared/player-ipc.ts` and `src/shared/catalog-ipc.ts`; add each with a contract and test.
- Catalog SQLite (`better-sqlite3`, `npmRebuild: false`, `asarUnpack`) runs in a `utilityProcess` (`src/utility/`) over a fenced `MessagePort` (`CatalogBridge.onDisconnected` surfaces unexpected worker crashes in `CatalogCrashBanner.tsx` with reconnect); `SecretStore` (`safeStorage` -> `userData/secrets.json`) stays in main (`src/main/catalog/`).
- Main diagnostic logs go through `src/main/log.ts` (10 MiB rolling cap + backup, mandatory `redactUrls()`). OS media controls (`renderer/src/media-session.ts`) consume typed `MediaSessionMetadata` (no DOM scraping; `previoustrack`/`nexttrack` only on multi-channel live).
- Put icons/entitlements in `resources/` (`build/` is gitignored). Desktop signing is tracked separately (`#77`); Electron downloads on first run.
- Never read `.env.local` directly (`pnpm run:app` supplies `DEV_*` in dev only; `__ELV_DEV_SEED__` strips `dev-seed.ts` in prod, nothing mapped to `renderer/`). `renderer/src/App.tsx` mounts `AppShell` with `DesktopEngine` + `PlayerView`.

## mpv IPC (`src/main/player/mpv/`; engine: `src/main/player/AGENTS.md`)
- `codec.ts` (JSON lines), `client.ts` (request ids, 3 s `MpvWedgedError`, events), `process.ts` (Win: hidden launcher, named pipe + `--elv-parent-pid`, pid sweep; macOS: `.app/Contents/MacOS/mpv` over `fd://3`, respawns on `cocoa-cb` `osd-width=0` init wedge). Keep >= 90 % coverage.
- `spike.integration.test.ts` runs real mpv vs `pnpm sim` (`ELV_MPV_SPIKE=1`); `ELV_RECORD_MPV_FIXTURES=1` updates `fixtures/`.
- Runtime (mpv 0.42.0, win/mac/linux): `--osc=no`, `--osd-level=0`, `--input-default-bindings=no`, `--demuxer-lavf-probe-info=yes`; `launchArgs` parameterizes `hwdec` (`auto-safe`|`auto-copy`|`no`|`darwin-compat` with `uyvy422`), `--video-timing-offset=0` (`renderContext`), and `--pulse-buffer=50` (linux). `child-window` uses `--input-vo-keyboard=no`; `own-window` uses `--input-vo-keyboard=yes` for `mpv-input.conf`. macOS omits `--curl-enabled=no`/Vulkan (`cocoa-cb` + `videotoolbox`).
- Fault signatures: `ffmpeg warn http: HTTP error <status>`; refused port is `ffmpeg error tcp:` + `end-file error "loading failed"`; `text-notice` logs `Mime-type: 'text/plain'` + `unrecognized file format`; live drop is `end-file eof`.
- Custom headers pass via `set_property http-header-fields string[]` (`[]` cleared on next load/stop); UA/Referer use `loadfile`. Windows pipe DACL is current-user; macOS `fd://3` has no path.

## Presentation (`src/main/player/presenter/`)
- `VideoPresenter` has three implementations (`createPresenter` / `choosePresenter`, overridable via `ELV_DESKTOP_PRESENTER`).
- Canvas (Windows default, `coversArea: false`): `elv-mpv.exe --elv-canvas-pipe=...` (`native/mpv-host/elv-mpv-canvas.h`) renders `vo=libmpv` (`--force-window=no`, `--video-timing-offset=0`) via `MPV_RENDER_API_TYPE_D3D11` into a triple-buffered shared `ID3D11Texture2D` ring, duplicates NT handles to main -> Electron `sharedTexture` -> sandboxed preload `onFrame` -> `<PlayerCanvas>`, so React DOM overlays composite over video in one `BrowserWindow`.
- Child window (Windows fallback): mpv draws (`--wid`) into a frameless `transparent`, non-focusable (`focusable: false`) owned video window; mpv fullscreen turns back to the app window.
- Own window (macOS/Linux default until macOS `libmpv.2.dylib` artifact lands): follows host `move`/`resize`, syncs fullscreen bidirectionally (400 ms guard + post-transition geometry reconcile). Win `--geometry` is physical px; macOS takes backing px (`rect * scaleFactor`) from `display.workArea`, defaulting `fullscreenMode` to `'safe-area'` (notched `workArea`) without modesetting (`'desktop'` spans full `bounds`).

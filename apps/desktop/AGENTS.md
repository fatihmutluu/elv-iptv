# desktop (`@elv/desktop`)

Electron shell for Windows, macOS and Linux. The UI is `renderer/` (`@elv/desktop-renderer`), a small
Expo project with `platforms: ["web"]` rendered by react-native-web.

## Commands
- `pnpm dev:ui` (`scripts/dev-ui.mjs`) runs the browser UI Workbench (`http://localhost:8081`) with its loopback live-data bridge (`src/dev/`); `pnpm dev:desktop` (`scripts/dev-hot.mjs`) runs Metro + unpackaged Electron (`ELV_DEV_SERVER_URL`).
- `pnpm run:app windows|macos|linux run|build` calls this package's `dev` and `build` scripts.
- `prepare:app` runs `pnpm -w mpv fetch` (`mpv-runtime.lock.json`), exports `renderer/`, and bundles main, preload + utility worker.
- `build` runs `prepare:app`, then `electron-builder --publish never` (`extraResources` bundles `mpv/` + `mpv-input.conf` on win/mac).
- `test` runs Vitest (`pnpm check`); `test:e2e` runs Playwright (`app`, `catalog`, `packaged` over CDP, `player`, opt-in `presenter`). `pnpm gate desktop` runs the zap/fault/orphan gate (`renderer/src/gate/AGENTS.md`).

## Rules
- `package.json` `main` is the bundled main process; the Expo entry lives only in `renderer/`.
- The renderer loads from `app://elv/` via `protocol.handle`; paths go through `resolveAppFile`,
  which refuses anything outside `dist/renderer`. Keep the CSP header in `app-protocol.ts`.
- Windows keep `contextIsolation`, `sandbox` and no `nodeIntegration`; the preload is CommonJS.
- IPC channels and runtime guards live in `src/shared/player-ipc.ts` and `src/shared/catalog-ipc.ts`; add each with a contract and test.
- Catalog SQLite (`better-sqlite3` N-API prebuilds, `npmRebuild: false`, `asarUnpack`) runs inside an Electron `utilityProcess` (`src/utility/`) talking directly to preload over a fenced `MessagePort`; `SecretStore` (`safeStorage` async API -> `userData/secrets.json`) stays in main (`src/main/catalog/`).
- Put icons and entitlements in `resources/` (`build/` is gitignored). `icon.png` is placeholder art.
- Desktop signing is tracked separately (`#77`); the `appx` identity and publisher are placeholders the Store assigns later.
- The Electron binary downloads on first run (Electron 45 has no postinstall).
- Never read `.env.local` directly here (`pnpm run:app` supplies `DEV_*` to main in development only; `scripts/bundle.mjs` defines `__ELV_DEV_SEED__` so `dev-seed.ts` runs once when `!app.isPackaged` and is stripped in production, with nothing mapped to `renderer/`, `#10`). `renderer/src/App.tsx` mounts `AppShell` (`#13`) with `DesktopEngine` + `PlayerView` outside `--elv-gate=`.

## mpv IPC (`src/main/player/mpv/`; the engine on top: `src/main/player/AGENTS.md`)
- `codec.ts` (JSON lines), `client.ts` (request ids, 3 s `MpvWedgedError`, events), `process.ts` (Windows: hidden
  launcher, `\\.\pipe\elv-mpv-<16 hex>` with retry and `--elv-parent-pid`, pid sweep; macOS: `.app/Contents/MacOS/mpv`
  over `stdio[3]` `--input-ipc-client=fd://3`, respawns if `cocoa-cb` wedges `osd-width=0` at init on macOS 26, exits 0
  in 9-240 ms when fd 3 closes). Keep >= 90 % line coverage.
- `spike.integration.test.ts` runs real mpv against `pnpm sim` (`ELV_SIM_URL`); opt-in via `ELV_MPV_SPIKE=1` on win32
  and darwin. `ELV_RECORD_MPV_FIXTURES=1` re-records `fixtures/*.jsonl` (win32) or `fixtures/darwin/*.jsonl` (darwin).
- Runtime (mpv 0.42.0, win32 + darwin): OSC, OSD and default bindings are disabled (`--osc=no`, `--osd-level=0`,
  `--input-default-bindings=no`); `child-window` sets `--input-vo-keyboard=no`, `own-window` sets `--input-vo-keyboard=yes`
  for `mpv-input.conf`. `loadfile replace` x10 at 300 ms gives no 509 (`loadMode`: `replace`). macOS omits
  `--curl-enabled=no` and Vulkan; mpv picks `vo=libmpv` (`cocoa-cb`, OpenGL) with `videotoolbox` hwdec.
- Fault signatures (FFmpeg networking): `ffmpeg warn http: HTTP error <status>`; refused port is
  `ffmpeg error tcp: Connection to tcp://... failed` + `end-file error "loading failed"`; `text-notice` logs
  `Mime-type: 'text/plain'` + `end-file error "unrecognized file format"`; live drop is `end-file eof`.
- `http-header-fields`: string-list syntax swallows the next header after a trailing `\` and doubles `\\`, so custom
  headers pass as a `set_property http-header-fields string[]` array (`[]` cleared on next load/stop); UA/Referer use `loadfile`. Windows pipe DACL is current-user (`GetAccessControl`); macOS `fd://3` has no path.

## Presentation (`src/main/player/presenter/`)
- `VideoPresenter` has two implementations; `createPresenter` wires them to Electron, `choosePresenter` picks one.
- Child window (Windows default): mpv draws (`--wid`) into a frameless `transparent` video window owned by the app
  window (DirectComposition covers an opaque child) and kept on the area; mpv fullscreen turns back to the app window.
- Own window (macOS default; Windows fallback): `--geometry` is physical screen pixels on Windows (frame top-left,
  title bar covers ~30 DIP). On macOS (`cocoa-cb`, `hidpi-window-scale=no`, full-size content view; measured on M3 Max
  Retina 2x), `--geometry` takes backing pixels (`rect * scaleFactor`) top-down from `display.workArea` (`visibleFrame`)
  top-left (`macOwnWindowGeometry`: `1600x900+400+740` places an `800x450` pt window at `(200, 400)`).
- Go/no-go (Windows 10, 150 %): child passed; video in 719-793 ms, 1200x675 px for 800x450 DIP, JS ping 0-5 ms.

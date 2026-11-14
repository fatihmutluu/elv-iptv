# desktop (`@elv/desktop`)

Electron shell for Windows, macOS and Linux. The UI is `renderer/` (`@elv/desktop-renderer`), a small
Expo project with `platforms: ["web"]` rendered by react-native-web.

## Commands
- `pnpm run:app windows|macos|linux run|build` calls this package's `dev` and `build` scripts.
- `dev` exports the renderer, bundles main and preload with esbuild into `dist/`, launches Electron.
- `build` does the same, then `electron-builder --publish never` for the current OS into `release/`.
- `test` runs the Vitest unit tests (run by `pnpm check`); `test:e2e` runs the Playwright `_electron`
  smoke test against the bundled app and is not part of `pnpm check`.

## Rules
- `package.json` `main` is the bundled main process; the Expo entry lives only in `renderer/`.
- The renderer loads from `app://elv/` via `protocol.handle`; paths go through `resolveAppFile`,
  which refuses anything outside `dist/renderer`. Keep the CSP header in `app-protocol.ts`.
- Windows keep `contextIsolation`, `sandbox` and no `nodeIntegration`; the preload is CommonJS.
- No IPC channels yet; add each one with a typed contract and a test.
- Put icons and entitlements in `resources/` (`build/` is gitignored). `icon.png` is placeholder art.
- No signing in Round 0; the `appx` identity and publisher are placeholders the Store assigns later.
- The Electron binary downloads on first run (Electron 45 has no postinstall).
- Never read `DEV_*` or `.env.local` here; nothing is mapped into the renderer.

## mpv IPC (`src/main/player/mpv/`)
- `codec.ts` (JSON lines), `client.ts` (request ids, 3 s `MpvWedgedError`, events), `process.ts` (spawn the launcher
  hidden, random `\.\pipe\elv-mpv-<16 hex>` per launch, connect with retry, `quit`, pid file sweep). Unit tests use a
  fake pipe; coverage of these three files must stay at 90 % lines.
- `spike.integration.test.ts` runs the real launcher against `pnpm sim` (`ELV_SIM_URL`). It is opt-in (opens mpv
  windows, about 30 s): set `ELV_MPV_SPIKE=1`; it also needs win32, the runtime and the simulator, else it skips.
  `ELV_RECORD_MPV_FIXTURES=1` implies it and re-records `fixtures/*.jsonl` (rerun after a runtime update).
- Spike outcome (mpv 0.42.0): Lua yes and the OSC runs (`osc-visibility` replies `success`), so no scripting task.
  `loadfile replace` x10 at 300 ms: no 509, one simulator connection at a time, so `loadMode` stays `replace`.
- Fault signatures (with `curl-enabled=no`, FFmpeg networking): `ffmpeg warn http: HTTP error <status>`; a refused
  port is `ffmpeg error tcp: Connection to tcp://... failed` plus `end-file error "loading failed"`; the `text-notice`
  has no error line, only `Mime-type: 'text/plain'` and `end-file error "unrecognized file format"`; a live drop is
  `end-file eof` with no error line. Without `curl-enabled=no` mpv's own `curl` stream answers with other texts.
- `http-header-fields` in a loadfile option map: only the comma needs a backslash (`a\,b\c` arrives as `a,b\c`); a
  doubled backslash arrives doubled, and the `%n%` length prefix is not supported. The user agent has its own option.
- The IPC pipe is created by mpv with a DACL for the current user only (checked with `GetAccessControl`), so other
  local users cannot open it; the random name only stops same-user guessing, which a same-user process can do anyway.

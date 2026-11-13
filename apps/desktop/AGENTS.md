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

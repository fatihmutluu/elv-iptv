# Wave C5B Design Spec — Desktop OS Native Integrations (`#301`, `#238`, `#259`)

## Scope
Completes Wave C5 across macOS, Linux, and Windows/cross-platform desktop shell integrations:
1. **`#259` — Forward OS `open-file` / `second-instance` `.m3u`/`.m3u8` Paths to Desktop Renderer:** Capture local playlist file launches from macOS `open-file`, Windows/Linux `second-instance` argv, and cold-start `process.argv`; validate & read safely in main without leaking host filesystem paths to the renderer; stage into `SourcesScreen` cleanly; register `fileAssociations` in `electron-builder.yml`.
2. **`#238` — Linux MPRIS2 D-Bus Media-Key & Lock-Screen Bridge:** Pure TypeScript/Node minimal D-Bus wire client over `$DBUS_SESSION_BUS_ADDRESS` Unix socket (zero new npm dependencies, zero GPL deps) exporting `/org/mpris/MediaPlayer2` (`org.mpris.MediaPlayer2` + `org.mpris.MediaPlayer2.Player`) synchronized with `MpvEngine` and sanitized `MediaSessionMetadata`.
3. **`#301` — macOS Hardware Media Keys (`NX_KEYTYPE_*` / `MPRemoteCommandCenter`) & Multi-Monitor `screensHaveSeparateSpaces` Guard:** Zero-permission-prompt Objective-C N-API v8 macOS helper (`elv-macos-media.m`) wiring `MPRemoteCommandCenter` + `MPNowPlayingInfoCenter` + `[NSScreen screensHaveSeparateSpaces]` (with safe active-playback `globalShortcut` fallback when native addon is absent), plus multi-monitor borderless fullscreen guard when `screensHaveSeparateSpaces === false`.

## Architecture

### 1. Shared Main-Process Media Session Metadata IPC (`#238` & `#301`)
- Add typed `setMediaMetadata(metadata: DesktopMediaMetadata | null)` command in `apps/desktop/src/shared/player-ipc.ts` (strictly validated; artwork URLs sanitized via `sanitizeMediaArtworkUrl` stripping userinfo/credential query params before crossing into MPRIS2 / `MPNowPlayingInfoCenter`).
- Emit remote media transport actions (`play`, `pause`, `togglePlayPause`, `stop`, `next`, `previous`, `seekBy`, `seekTo`) from main OS bridges back to `MpvEngine` (and track-step `next`/`previous` back to renderer `media-session` / player handoff!).
- Forward `MediaSessionMetadata` from `apps/desktop/renderer/src/App.tsx` / `media-session.ts` to main on every metadata update and clear on stop/close.

### 2. `#259` — OS `.m3u` / `.m3u8` File Open & Second-Instance Forwarding
- **`apps/desktop/src/main/single-instance.ts`:** Update `SingleInstanceApp` and `startSingleInstance` so `second-instance` passes `(commandLine, workingDirectory)` into `onSecondInstance(commandLine, workingDirectory)`.
- **`apps/desktop/src/main/playlist-open.ts`:**
  - Pure `extractPlaylistPathsFromArgv(argv, cwd?)`: skips `--*` flags & `--elv-gate*`, filters `.m3u`, `.m3u8`, `.m3u.gz` (case-insensitive), rejects URLs (`http://`, `https://`, `file://`), control chars, and overly long paths.
  - `readValidatedPlaylistFile(filePath)`: uses `lstatSync` to enforce regular non-symlink file (`!stat.isSymbolicLink() && stat.isFile()`) and `stat.size <= 64 * 1024 * 1024` (matching `LocalPlaylistStore`), reads `{ name: basename(filePath), bytes: Uint8Array }` strictly in main — NEVER exposing host filesystem paths to the renderer!
- **`apps/desktop/src/main/main.ts`:** Register `app.on('open-file', ...)` **before** `app.whenReady()`; process cold-start `process.argv` (skipped when `gateQuery !== null`); buffer validated `{ name, bytes }` entries in a bounded pending queue (max 8) and push via `sources:open-playlist-file` IPC once the renderer subscribes (plus pull via `sources:consume-pending-playlists`).
- **`apps/desktop/src/shared/sources-ipc.ts`, `src/main/sources-ipc.ts`, `src/preload/sources-bridge.ts`, `renderer/src/App.tsx` & `packages/features/src/ports/source-import-host.ts` / `AppShell.tsx` / `SourcesScreen.tsx`:** Wire pending/incoming local playlist payloads to navigate to Sources and pre-stage the local file ready for immediate import/category picking!
- **`apps/desktop/electron-builder.yml`:** Add `fileAssociations` (`ext: ['m3u', 'm3u8']`, `name: 'M3U Playlist'`) for `win`, `mac`, and `linux`.

### 3. `#238` — Linux MPRIS2 D-Bus Bridge (`apps/desktop/src/main/mpris/`)
- **`dbus-wire.ts`:** Minimal, zero-dependency pure-TypeScript D-Bus 1.0 binary protocol codec & socket client (little-endian framing, `EXTERNAL` UID SASL auth over Unix domain socket from `$DBUS_SESSION_BUS_ADDRESS`, `METHOD_CALL`/`METHOD_RETURN`/`ERROR`/`SIGNAL` marshalling for `s`, `o`, `g`, `b`, `u`, `i`, `x`, `d`, `v`, `a{sv}`, `as`). Tested 100% deterministically over an in-memory `Duplex` stream!
- **`mpris-bridge.ts`:** Registers `org.mpris.MediaPlayer2.elv_iptv` and exports `/org/mpris/MediaPlayer2`:
  - `org.mpris.MediaPlayer2`: `CanQuit`, `CanRaise`, `HasTrackList: false`, `Identity: 'ELV IPTV'`, `DesktopEntry: 'elv-iptv'`, `SupportedUriSchemes: []`, `SupportedMimeTypes: []`, plus `Raise()` and `Quit()`.
  - `org.mpris.MediaPlayer2.Player`: `PlaybackStatus` (`Playing`/`Paused`/`Stopped` with 400 ms `isNavigating` debounce during zaps so GNOME/KDE notifications never blink `Stopped`), `Rate`, `Metadata` (`mpris:trackid`, `xesam:title`, `xesam:artist`, `mpris:artUrl` sanitized, `mpris:length` µs), `Volume`, `Position` µs, `CanGoNext`, `CanGoPrevious`, `CanPlay`, `CanPause`, `CanSeek` (`kind === 'vod' && durationMs > 0`), `CanControl: true`; emits `PropertiesChanged` and `Seeked` signals.
- **`apps/desktop/src/main/main.ts`:** On `process.platform === 'linux'`, append Chromium switch `--disable-features=MediaSessionService,HardwareMediaKeyHandling` before `app.whenReady()` to avoid duplicate MPRIS instances; degrade silently to no-op if D-Bus socket is absent/unreachable.

### 4. `#301` — macOS Hardware Media Keys & `screensHaveSeparateSpaces` Guard
- **`apps/desktop/native/mpv-host/elv-macos-media.m`:** Tiny Objective-C N-API v8 native module (`-framework MediaPlayer -framework AppKit -framework Foundation`) exposing:
  - `screensHaveSeparateSpaces(): boolean` -> `[NSScreen screensHaveSeparateSpaces]`
  - `installRemoteCommands(onCommand)` -> registers `MPRemoteCommandCenter.sharedCommandCenter()` (`play`, `pause`, `togglePlayPause`, `stop`, `nextTrack`, `previousTrack`, `skipForward`, `skipBackward`, `changePlaybackPosition`) via `napi_threadsafe_function` + removes all target tokens cleanly in `destroy()`
  - `setNowPlaying(info)` -> populates `MPNowPlayingInfoCenter.defaultCenter()` (`nowPlayingInfo` + `playbackState`) or clears on `null`.
- **`apps/desktop/src/main/macos-media.ts`:** Loads `elv-macos-media.node` on `darwin` (graceful fallback when unavailable: guarded active-playback `globalShortcut` registration for `MediaPlayPause`/`MediaNextTrack`/`MediaPreviousTrack`/`MediaStop`, unregistered immediately when playback stops so other apps aren't hijacked!).
- **`apps/desktop/src/main/player/presenter/create.ts`, `own-window.ts`, `window.ts`, `main.ts`:**
  - When `process.platform === 'darwin'`, `displays.length > 1`, and `screensHaveSeparateSpaces() === false`, guard fullscreen transitions to use borderless `simpleFullscreen` (`setSimpleFullScreen`) instead of native Space fullscreen so secondary displays are not blanked and `own-window` never fights cross-Space transitions; pin `screenIndexOf` strictly to the display matching `appWindow.getContentBounds()`.

## Verification
- `pnpm check` (`11 passed, 0 failed`), pure TypeScript D-Bus wire & MPRIS2 unit tests, macOS `screensHaveSeparateSpaces` + fullscreen policy & `elv-macos-media.m` compile verification on `elv-mac`, `open-file` / `second-instance` security & symlink/size/traversal tests.
- Independent whole-branch review (`VERDICT: PASS`) and green GitHub CI across Windows, macOS, and Ubuntu!

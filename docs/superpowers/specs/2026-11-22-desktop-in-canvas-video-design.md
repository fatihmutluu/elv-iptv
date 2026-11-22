# Wave 4C — Desktop In-Canvas Video Compositing (`#95`)

**Date:** 2026-11-22
**Branch:** `feat/desktop-in-canvas-video`
**Refs:** `#95`

## 1. Goal

Deliver zero-copy, sandbox-safe, out-of-process in-canvas video rendering for Electron desktop so shared React Native Web overlays (OSD controls, channel list, EPG info, track pickers, settings sheets, and error cards) composite directly over live and VOD video inside a single `BrowserWindow` without weakening `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, or LGPL dynamic linking.

This first delivery (Wave 4C-1) ships:
1. The cross-platform `'canvas'` presenter architecture (`PresenterKind = 'canvas' | 'child-window' | 'own-window'`, `coversArea: false`), sandboxed Electron `sharedTexture` preload bridge (`PlayerBridge.onFrame`), and `<canvas>` compositor (`PlayerCanvas` + `PlayerView`).
2. The complete Windows zero-copy GPU implementation (`elv-mpv.exe` `--elv-canvas-pipe` using `libmpv-2.dll` `MPV_RENDER_API_TYPE_D3D11` -> triple-buffered shared `ID3D11Texture2D` -> `DuplicateHandle` -> Electron `sharedTexture.importSharedTexture` / `sendSharedTexture` -> `VideoFrame` -> `<canvas>`), enabled as the Windows default (`WINDOWS_DEFAULT_PRESENTER = 'canvas'`, with `ELV_DESKTOP_PRESENTER` override and `child-window` fallback preserved).
3. macOS LGPL `libmpv.2.dylib` build support in `tools/mpv-runtime/build-macos.sh` (`-Dlibmpv=true`) and `tools/src/mpv/fetch.ts` licence verification so CI produces the `darwin-arm64` shared library needed for macOS in-canvas activation in Wave 4C-2, plus Linux `mpv-input.conf` packaging parity in `apps/desktop/electron-builder.yml`.

## 2. Architecture & Security Invariants

### 2.1 Out-of-Process Crash Isolation & Zero N-API Addon on Windows
- `elv-mpv.exe` remains an isolated child process loading `libmpv-2.dll` dynamically (`LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR`). A decoder or demuxer crash kills only `elv-mpv.exe`, never Electron main or the renderer.
- Zero Node N-API addon and zero `node-gyp` build step are introduced on Windows (`npmRebuild: false` preserved). `elv-mpv.exe` loads `d3d11.dll` dynamically from System32 (`LOAD_LIBRARY_SEARCH_SYSTEM32`), creates a multithreaded D3D11 device (trying `D3D_DRIVER_TYPE_HARDWARE` first and falling back to `D3D_DRIVER_TYPE_WARP` for headless VMs/CI), calls `ID3D10Multithread::SetMultithreadProtected(TRUE)` so `d3d11va` decodes zero-copy on the same GPU device, and renders `vo=libmpv` via `MPV_RENDER_API_TYPE_D3D11`.

### 2.2 Triple-Buffered Named-Pipe Frame Protocol
- `CanvasPresenter` listens on a per-presenter Windows named pipe `\\.\pipe\elv-mpv-canvas-<16 hex>` (`exclusive: true`, accepting at most one client) and passes `--elv-canvas-pipe=<pipe>` and `--input-vo-keyboard=no` to `elv-mpv.exe`.
- When `presenter.kind === 'canvas'`, `factory.ts` sets `renderContext: true`, causing `options.ts` to replace `--force-window=immediate` with `--force-window=no` and emit `--vo=libmpv` and `--video-timing-offset=0`.
- Minimal line-delimited ASCII protocol over the canvas pipe (never carrying URLs or credentials):
  - Main -> `elv-mpv.exe`: `R <width> <height>\n` (physical pixels clamped `[16, 4096]`), `I <gen> <slot>\n` (surface-import ack so `elv-mpv.exe` closes the duplicated parent NT handle via `DUPLICATE_CLOSE_SOURCE` right after Electron duplicates it for the GPU process), `A <gen> <slot>\n` (frame slot ack after `sendSharedTexture` settles).
  - `elv-mpv.exe` -> Main: `S <gen> <slot> <uint64_dup_handle> <width> <height>\n` (triple-buffered `DXGI_FORMAT_B8G8R8A8_UNORM` shared `ntHandle` duplicated into parent PID via `DuplicateHandle`), `F <gen> <slot> <width> <height>\n` (new rendered frame ready in `<slot>`).
- `elv-mpv.exe` uses a Win32 auto-reset Event in `mpv_render_context_set_update_callback` to coalesce rapid updates onto a dedicated render thread, rotates across 3 slots without overwriting any un-acked slot (dropping excess frames when the renderer falls behind), and calls `mpv_render_context_free(rc)` before `mpv_terminate_destroy(h)` on shutdown.

### 2.3 Main -> Sandboxed Preload -> Renderer `<canvas>` Lifecycle
- Main imports each `S` message once per `(gen, slot)` via `sharedTexture.importSharedTexture({ textureInfo: { pixelFormat: 'bgra', codedSize, handle: { ntHandle } } })`, releases superseded generations cleanly, and emits `surface: created`.
- On each `F` message, if visible and not minimized/destroyed, Main sends the cached `SharedTextureImported` via `sharedTexture.sendSharedTexture({ frame: appWindow.webContents.mainFrame, importedSharedTexture }, engineId)` and replies `A <gen> <slot>\n` in `.finally()`. Hidden/minimized/stale frames immediately ack without GPU transfer.
- Sandboxed preload (`preload.ts` + `player-bridge.ts`) registers `sharedTexture.setSharedTextureReceiver` once, routes `importedSharedTexture.getVideoFrame()` to the registered `engineId` callback on frozen `window.elv.player`, always calls `importedSharedTexture.release()` in `finally`, and closes unconsumed/errored `VideoFrame` instances immediately to prevent GPU leaks.
- `PlayerCanvas.tsx` draws each `VideoFrame` onto a full-area `<canvas>` (`pointerEvents: 'none'`, CSS `objectFit: resizeMode === 'fill' ? 'cover' : 'contain'`), resizes backing pixels only on dimension change, always calls `frame.close()` in `finally`, and clears on `failed` or unmount.
- Fullscreen in `CanvasPresenter` toggles `appWindow.setFullScreen(...)` directly in one `BrowserWindow`.

### 2.4 macOS `libmpv` Prep & Linux Packaging
- `tools/mpv-runtime/build-macos.sh` enables `-Dlibmpv=true`, copies `libmpv*.dylib` into `Contents/Frameworks/` (rewriting install names/rpaths and ad-hoc signing), and packages `Contents/Resources/include/mpv/` so `mpv-runtime.yml` produces an LGPL `darwin-arm64` runtime ready for Wave 4C-2 macOS `IOSurface` canvas compositing.
- `tools/src/mpv/fetch.ts` scans `libmpv[^/]*\.dylib` alongside FFmpeg dylibs and `mpv` for LGPL verification.
- `apps/desktop/electron-builder.yml` adds `mpv-input.conf` to `linux.extraResources`.

### 2.5 macOS Zero-Copy `IOSurface` In-Canvas Compositing (Wave 4C-2)
- **Out-of-process macOS host (`elv-mpv-macos.c` + `elv-mpv-macos-canvas.h`):**
  - Compiled with `clang -O2 -Wall -Wextra -Werror` and ad-hoc signed (`codesign --force --sign -`) into `ELV IPTV Player.app/Contents/MacOS/elv-mpv` right next to `mpv`. Because it sits inside `Contents/MacOS/`, `dlopen` of sibling `../Frameworks/libmpv.2.dylib` resolves all `@executable_path/../Frameworks/*.dylib` dependencies natively with no `DYLD_LIBRARY_PATH` and full Hardened Runtime compatibility.
  - Enforces the same hardened defaults as Windows `elv-mpv.exe`, accepts `--input-ipc-client=fd://3` (matching `spawnDarwinMpv` unchanged) and `--elv-canvas-pipe=<unix-socket-path>`, monitors parent exit via `kqueue` `EVFILT_PROC`/`NOTE_EXIT` plus Unix socket EOF, and arms a 3-second shutdown watchdog.
  - Owns its entire OpenGL 3.2 Core (`CGL`) context and `mpv_render_context` (`MPV_RENDER_API_TYPE_OPENGL`) strictly on a single dedicated render thread (trying `kCGLPFAAccelerated` first and falling back to Apple's software GL renderer `kCGLRendererGenericFloatID` on headless VMs).
  - Allocates a triple-buffered `'BGRA'` `IOSurface` ring bound via `CGLTexImageIOSurface2D` (`GL_TEXTURE_RECTANGLE`) to FBOs, renders with `MPV_RENDER_PARAM_FLIP_Y = 0` (empirically verified on Apple Silicon macOS 26 so IOSurface row 0 matches the top of the video frame), calls `glFlush()` + `glFinish()` before `mpv_render_context_report_swap`, and retains each emitted `IOSurfaceRef` in a bounded `PendingSurfaceTable` until Main acknowledges `I <gen> <slot>\n` (or EOF/shutdown), guaranteeing zero lookup races and zero leaked `IOSurface`s.
- **Minimal ABI-stable N-API helper (`elv-iosurface.c` -> `elv-iosurface.node`):**
  - ~75 lines of C compiled directly by `tools/src/mpv/launcher.ts` against Node's bundled `include/node/node_api.h` (`NAPI_VERSION 8`, zero npm dependencies, zero `node-gyp`), ad-hoc signed, and shipped under `resources/mpv/elv-iosurface.node` (outside `app.asar`, loaded via `process.dlopen`).
  - Exports strictly `lookup(surfaceId: number): Buffer | null` (`IOSurfaceLookup` returning an 8-byte `IOSurfaceRef` pointer buffer) and `release(surfaceBuf: Buffer): void` (`CFRelease`).
- **Main-process presenter & runtime selection:**
  - `CanvasPresenter` creates a per-session Unix domain socket inside a `0o700` temp directory (kept well under the 104-byte `SUN_LEN` limit, with socket mode `0o600` and deterministic cleanup on dispose), looks up each `S` `IOSurfaceID` into a local `IOSurfaceRef`, passes `handle: { ioSurface }` to Electron's `sharedTexture.importSharedTexture`, releases the temporary `IOSurfaceRef` in `finally`, and sends `I <gen> <slot>\n`.
  - `DARWIN_DEFAULT_PRESENTER = 'canvas'` makes in-canvas compositing the macOS default whenever `elv-mpv` and `elv-iosurface.node` are present, while preserving `ELV_DESKTOP_PRESENTER=own-window` (using standalone `Contents/MacOS/mpv`) as an explicit fallback.
  - `apps/desktop/mpv-runtime.lock.json` pins the LGPL `darwin-arm64` runtime from `mpv-runtime.yml` run `44996151000` (`libmpv.2.dylib` + `include/mpv/`).

## 3. Verification

- Strict TDD across `canvas.test.ts`, `iosurface.test.ts`, `choose.test.ts`, `create.test.ts`, `runtime-path.test.ts`, `options.test.ts`, `factory.test.ts`, `ipc.test.ts`, `player-bridge.test.ts`, `desktop-engine.test.ts`, `PlayerCanvas.test.tsx`, `mpv-fetch.test.ts`, `mpv-launcher.test.ts`, and `mpv-launcher.integration.test.ts`.
- Windows: MSVC `/O2 /W4 /WX` build + integration tests + Playwright `e2e/player.spec.ts` + `e2e/browse-play.spec.ts`.
- macOS (`elv-mac` Apple Silicon + GitHub Actions `macos-26`): `clang -O2 -Wall -Wextra -Werror` build of `elv-mpv` and `elv-iosurface.node`, live `mpv-launcher.integration.test.ts` (including `fd://3` IPC, `S`/`F`/`R`/`I`/`A`, cross-process `IOSurfaceLookup`, and 20-resize zero-leak check), packaged `.dmg` build + `e2e/packaged.spec.ts` + `e2e/player.spec.ts`.
- Full `pnpm check` (`11 passed, 0 failed`) and independent `Gemini 4 Neon (XHigh)` whole-branch code review (`VERDICT: PASS`).

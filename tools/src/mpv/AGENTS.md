# mpv runtime (`tools/src/mpv/`)

`pnpm mpv fetch [--force]` installs and `pnpm mpv verify` rescans the pinned desktop mpv runtime.

- `apps/desktop/mpv-runtime.lock.json` pins one runtime per `<platform>-<arch>` (upstream release URL or CI workflow
  artifact, SHA-256). Upstream entries must come from `github.com/mpv-player/mpv/releases/download/`.
- `fetch` downloads into `.cache/mpv/<key>/` (upstream: temp `.part` rename; workflow-artifact: `gh run download
  <runId> -R <repo> -n <artifact>`, needing `GH_TOKEN` with `actions: read` in CI), checks SHA-256 (mismatches delete;
  stale cache files are replaced), and extracts via system `tar` (`-xzf` for `.tar.gz`) into a fresh staging folder.
  Every path must stay contained with zero symlinks, else staging is removed and fetch fails. After the licence gate
  scans binaries as strings (nothing runs), the runtime moves to gitignored `apps/desktop/resources/mpv/<key>/` with
  `BUILDINFO.json` (preserving upstream `RUNTIME-BUILDINFO.json` or macOS `Resources/BUILDINFO.json` under
  `runtimeBuild`).
- Licence gate: FFmpeg without `--enable-gpl`/`--enable-nonfree`, mpv with `-Dgpl=false`. Scans every `*.dll` (including
  multi-DLL Windows layouts), `libavcodec*`, `libavformat*`, `libavutil*`, `libmpv*` dylibs and `mpv`.
- `verify` checks `BUILDINFO.json` SHA-256 against the lock and rescans; `verify --dir <folder>` gates a build folder.
- Windows CI runtime (`#94`): `.github/workflows/mpv-runtime.yml` (`win32-x64` on `windows-2025`, MSYS2 `MINGW64`) runs
  `tools/mpv-runtime/build-windows.sh` (local wrapper `build-windows.ps1`) from `versions.json` (`-march=x86-64
  -mtune=generic`, FFmpeg `--disable-gpl --disable-nonfree --enable-shared`, mpv `-Dgpl=false -Dlibmpv=true
  -Dcplayer=false -Dlua=luajit`), bundles `libmpv-2.dll`, transitive non-system DLLs via `objdump -p`, `include/mpv/`,
  `licenses/`, and `RUNTIME-BUILDINFO.json` with zero symlinks, and smoke-tests `LoadLibraryExW` + `mpv_client_api_version`.
- macOS runtime: `.github/workflows/mpv-runtime.yml` runs `tools/mpv-runtime/build-macos.sh` on `macos-26` from
  `tools/mpv-runtime/versions.json` (pkg-config sees only its prefix). Output `ELV IPTV Player.app` (`Info.plist`,
  `MacOS/mpv`, `Frameworks/*.dylib` via `@executable_path/../Frameworks/`, `Resources/include/mpv/`, licences,
  `BUILDINFO.json`), signed ad hoc. Artifacts expire after 90 days: re-run workflow and update lock. `backports` replace
  one source file (checked before/after SHA-256); drop once upstream releases it. No Vulkan -> mpv uses `vo=libmpv`/GL.
- Mac without `gh`: download on PC (`gh run download <runId> -n mpv-runtime-darwin-arm64 -D .cache/mpv/darwin-arm64`),
  copy `.tar.gz` to the Mac's `.cache/mpv/darwin-arm64/`, then run `pnpm mpv fetch`.
- Windows launcher: `launcher.ts` compiles `apps/desktop/native/mpv-host/elv-mpv.c` to `elv-mpv.exe` with MSVC
  (`vswhere` -> `vcvars64.bat`, `/W4 /WX`, Per-Monitor V2 DPI aware); loads `libmpv-2.dll` dynamically via
  `LoadLibraryExW` (LGPL replaceable). Fails clearly without Build Tools.
- macOS launcher & IOSurface addon: `launcher.ts` compiles `elv-mpv-macos.c` (with `elv-mpv-macos-canvas.h`) into
  `ELV IPTV Player.app/Contents/MacOS/elv-mpv` and `elv-iosurface.c` into `elv-iosurface.node` against Node's bundled
  `include/node/node_api.h` (`clang -O2 -mmacosx-version-min=13.0 -Wall -Wextra -Werror`), then ad-hoc signs both and
  re-signs `ELV IPTV Player.app`. `elv-mpv` dynamically `dlopen`s `../Frameworks/libmpv.2.dylib` via
  `_NSGetExecutablePath` (LGPL replaceable).
- Launcher contract: `--name=value`, `--name` (`yes`), `--no-name` (`no`) map to libmpv options; `--elv-parent-pid`
  quits mpv on parent exit (optional on macOS, defaults to `getppid()` via `kqueue` `EVFILT_PROC`/`NOTE_EXIT`);
  `--elv-canvas-pipe` drives `vo=libmpv` 5-slot ring-buffered shared textures (Win: `\\.\pipe\*` + D3D11 event query; macOS: `/abs/sock`
  + OpenGL/CGL 3.2 Core + `'BGRA'` `IOSurface` with `kCGLRendererGenericFloatID` fallback). Exit codes: 2 bad/rejected
  arg, 3 libmpv/symbol missing, 4 init failed, 5 parent pid unopenable.
- Hardening: sets `config=no`, `load-scripts=no`, `ytdl=no`, `load-unsafe-playlists=no`, `input-default-bindings=no`,
  `input-vo-keyboard=no`, `osc=no`, `osd-level=0` before caller args. A 3 s watchdog terminates stuck shutdowns (manual
  check: play a hung socket, kill parent, confirm gone within ~4 s).
- `elv-mpv.stamp` stores the SHA-256 of `apps/desktop/native/mpv-host/*.{c,h}`; `fetch` rebuilds a current Windows or
  macOS runtime when the stamp differs or any output (`elv-mpv.exe`, or `elv-mpv` + `elv-iosurface.node`) is missing.

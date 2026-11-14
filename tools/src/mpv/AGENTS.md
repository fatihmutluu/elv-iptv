# mpv runtime (`tools/src/mpv/`)

`pnpm mpv fetch [--force]` installs and `pnpm mpv verify` rescans the pinned desktop mpv runtime.

- `apps/desktop/mpv-runtime.lock.json` pins one runtime per `<platform>-<arch>` (URL or CI artifact, SHA-256). Windows
  entries must come from `github.com/mpv-player/mpv/releases/download/`.
- `fetch` downloads into `.cache/mpv/<key>/` (Windows: a temporary name, then renamed; macOS: `gh run download <runId>
  -R <repo> -n <artifact>`, which needs `GH_TOKEN` with `actions: read` in CI), checks the SHA-256 (a mismatch deletes
  the file; a stale cached file is replaced), then extracts with the system `tar` (`-xzf` for `.tar.gz`) into a fresh
  staging folder. Every staged path must resolve inside it and none may be a symlink, else the staging folder is
  removed and fetch fails. The licence gate then scans the binaries as strings (nothing runs) and the runtime moves to
  gitignored `apps/desktop/resources/mpv/<key>/` with `BUILDINFO.json`.
- Licence gate: FFmpeg configuration without `--enable-gpl` and `--enable-nonfree`, mpv options with `-Dgpl=false`.
  It scans `*.dll`, `libavcodec*`, `libavformat*` and `libavutil*` dylibs and the `mpv` binary.
- `verify` compares the installed `BUILDINFO.json` SHA-256 with the lock, then rescans; `verify --dir <folder>` only
  applies the gate to a folder (the CI build before upload).
- Windows pin update: download the new archive and its `.asc`, `gpg --verify` against the mpv release key, then change
  URL and SHA-256 in a normal PR.
- macOS runtime: `.github/workflows/mpv-runtime.yml` runs `tools/mpv-runtime/build-macos.sh` on `macos-26` from the
  pins in `tools/mpv-runtime/versions.json` (exact versions, tarball SHA-256 or tag commit; pkg-config sees only its
  own prefix). Output `ELV IPTV Player.app` (`Info.plist` from `tools/mpv-runtime/`; mpv in `MacOS/`, dylibs in
  `Frameworks/` loaded from `@executable_path/../Frameworks/`, licences and `BUILDINFO.json` in `Resources/`), signed
  ad hoc. The job summary prints the lock entry (run id, SHA-256); the artifact expires after 90 days: re-run the
  workflow and update the lock in a normal PR. Source pin update: check the upstream signature or release digest.
  `backports` replace one source file with its upstream version from a later commit (SHA-256 before and after);
  drop each one when a release contains it.
- The macOS build has no Vulkan, so `gpu`/`gpu-next` find no GPU context and mpv draws through `cocoa-cb`
  (`vo=libmpv`, OpenGL).
- Mac without `gh`: on a PC `gh run download <runId> -n mpv-runtime-darwin-arm64 -D .cache/mpv/darwin-arm64`, copy the
  `.tar.gz` into the Mac checkout's `.cache/mpv/darwin-arm64/`, then `pnpm mpv fetch` there uses it.
- Windows launcher: after the install, `launcher.ts` builds `apps/desktop/native/mpv-host/elv-mpv.c` into
  `elv-mpv.exe` beside the DLL with MSVC (`vswhere` finds `vcvars64.bat`; `/W4 /WX`). libmpv is loaded at run time with
  `LoadLibraryExW` from the exe folder, so the DLL stays replaceable (LGPL). Without Build Tools fetch fails clearly.
- Launcher contract: `--name=value`, `--name` (yes) and `--no-name` (no) become libmpv options; `--elv-parent-pid=<pid>`
  makes it quit mpv when that process exits. Exit codes: 2 bad argument or rejected option, 3 libmpv missing, 4 init failed.
- Hardening: before the caller's arguments the launcher sets `config=no`, `load-scripts=no`, `ytdl=no` and
  `load-unsafe-playlists=no` (the caller may override). The OSC is built in and still runs (`user-data/osc` exists).
  A watchdog thread ends the process 3 s after quit or shutdown starts. Exit 5: the parent pid cannot be opened.
  Manual check for the watchdog (no automated test can force a stuck shutdown): play from a socket that accepts and
  never answers, kill the parent, and confirm `elv-mpv.exe` is gone within about 4 s.
- The launcher is Per-Monitor V2 DPI aware (like mpv.exe), so `--geometry` and a `--wid` child use physical pixels.
  `elv-mpv.stamp` holds the SHA-256 of the `elv-mpv.c` it was built from; `fetch` rebuilds the launcher of a current
  runtime when the stamp is missing or differs, or the exe is gone.

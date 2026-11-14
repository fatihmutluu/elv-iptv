# mpv runtime (`tools/src/mpv/`)

`pnpm mpv fetch [--force]` installs and `pnpm mpv verify` rescans the pinned desktop mpv runtime.

- `apps/desktop/mpv-runtime.lock.json` pins one runtime per `<platform>-<arch>` (URL or CI artifact, SHA-256). Windows
  entries must come from `github.com/mpv-player/mpv/releases/download/`.
- `fetch` downloads to a temporary name, checks the SHA-256 (a mismatch deletes the file), then extracts with the system
  `tar -xf` into a fresh staging folder. Every staged path must resolve inside it and none may be a symlink, else the
  staging folder is removed and fetch fails. The licence gate then scans the binaries as strings (nothing runs) and the
  runtime moves to gitignored `apps/desktop/resources/mpv/<key>/` with `BUILDINFO.json`.
- Licence gate: FFmpeg configuration without `--enable-gpl` and `--enable-nonfree`, mpv options with `-Dgpl=false`.
- `verify` compares the installed `BUILDINFO.json` SHA-256 with the lock, then rescans.
- Pin update: download the new archive and its `.asc`, `gpg --verify` against the mpv release key, then change URL and
  SHA-256 in a normal PR.
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
  `fetch` skips a current runtime: after changing `elv-mpv.c` run `pnpm mpv fetch --force` (the archive is cached).

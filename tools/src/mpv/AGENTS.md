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

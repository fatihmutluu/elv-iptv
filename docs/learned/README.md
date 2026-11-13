# Lessons learned

Short dated entries: problem, then the rule that follows.

- 2026-11-13 Windows MAX_PATH breaks Expo Android ninja builds ("still dirty" path errors). Enable `LongPathsEnabled` or install with `pnpm install --virtual-store-dir C:\v`; `subst` does not help.
- 2026-11-13 The gitleaks GitHub Action fails on a repository's root commit. CI runs the gitleaks CLI instead.
- 2026-11-13 A file name containing `&` becomes command injection when passed through a shell. Stop and agent hooks never pass file names through a shell.
- 2026-11-13 release-please PRs opened with `GITHUB_TOKEN` do not trigger CI. Use a token that does, or trigger checks explicitly.
- 2026-11-13 Development builds embed `DEV_*` values in the app config `extra`. Development builds are never given to testers; release builds fail CI if a `DEV_` value is bundled.
- 2026-11-13 pnpm's minimum release age blocks just-published versions. Use `minimumReleaseAgeExclude` only for a time-boxed, commented exception.
- 2026-11-13 Sandboxed Electron preload scripts must be CommonJS; an ES module preload fails to load.
- 2026-11-13 Electron 45 downloads its binary lazily on first run, so there is no postinstall script to allow in pnpm.
- 2026-11-13 Expo's config loader needs the explicit `.ts` extension for TypeScript imports from `app.config.ts`.

# Lessons learned

Short dated entries: problem, then the rule that follows.

- 2026-11-13 Windows MAX_PATH breaks Expo Android ninja builds ("still dirty" path errors). Enable `LongPathsEnabled` or install with `pnpm install --virtual-store-dir C:\v`; `subst` does not help.
- 2026-11-13 The gitleaks GitHub Action fails on a repository's root commit. CI runs the gitleaks CLI instead.
- 2026-11-13 A file name containing `&` becomes command injection when passed through a shell. Stop and agent hooks never pass file names through a shell.
- 2026-11-13 release-please PRs opened with `GITHUB_TOKEN` do not trigger CI. Use a token that does, or trigger checks explicitly.
- 2026-11-13 Development builds embed `DEV_*` values in the app config `extra`. Development builds are never given to testers. Release builds must never contain `DEV_` values; a CI gate on release artifacts is planned.
- 2026-11-13 pnpm's minimum release age blocks just-published versions. Use `minimumReleaseAgeExclude` only for a time-boxed, commented exception.
- 2026-11-13 Sandboxed Electron preload scripts must be CommonJS; an ES module preload fails to load.
- 2026-11-13 Electron 45 downloads its binary lazily on first run, so there is no postinstall script to allow in pnpm.
- 2026-11-13 Expo's config loader needs the explicit `.ts` extension for TypeScript imports from `app.config.ts`.
- 2026-11-13 TV list gate baseline (`docs/learned/gates/list-android-tv.json`; Android TV emulator `elv_tv`, `sdk_google_atv64_x86_64`, Android 16 / API 36; development variant release APK with bundled JS, debug-signed; `pnpm gate list --runs 3 --real-keys 60`; 100,000 items, 600 moves at 20 per second): key-to-highlight p50 17.8 / p95 19.2 / max 21.2 ms, longest JS task 5.7 ms, 0 losses, 0 coalesced, real D-pad keys p95 20.3 ms, 605 frames (p50 17 / p95 18 / p99 19 ms), legacy janky 0.7 %. Three surprises. (1) A 4 ms `setInterval` fires once per frame on Android (16.7 ms at idle, 22 ms worst), so the first JS-gap sampler measured frame quantisation and could never meet 16 ms; the gap is now the larger of the per-move synchronous work and the `requestAnimationFrame` overshoot. (2) `adb shell input keyevent` reaches `TVEventHandler` only when a view has focus; a screen without a focusable view receives no remote keys. (3) The deadline-based `Janky frames` figure of `dumpsys gfxinfo` swung between 50 and 73 % across identical runs (host-GPU draw commands are slow) while the legacy figure stayed at 0.5 to 0.8 %; the gate enforces the legacy one and only warns about the other. The emulator's Google TV launcher can also open a dialog over the app after launch; the runner presses Back and restarts once, then fails naming the blocking activity.

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
- 2026-11-13 A 4 ms `setInterval` fires only once per frame in React Native on Android, so an event-loop sampler measures frame quantisation, not JS tasks. Measure JS work directly (dispatch to end of commit); estimate other stalls from `requestAnimationFrame` deltas, which resolve about one frame (a 30 ms stall shows, a 20 ms one does not).
- 2026-11-13 A tight `setImmediate` loop that watches for JS tasks starves the app. Never busy-loop to observe the event loop.
- 2026-11-13 Android TV delivers no remote keys to `TVEventHandler`, not even `adb shell input keyevent`, while no view has focus. Every TV screen needs a focusable root with `hasTVPreferredFocus`.
- 2026-11-13 The deadline-based "Janky frames" of `dumpsys gfxinfo` swung between 50 and 73 % across identical emulator runs while the legacy figure stayed below 1 %. On emulators enforce the legacy figure and only warn about the deadline one.
- 2026-11-13 The emulator's TV launcher can open a dialog over a freshly launched app. Gate runners check the resumed activity, press Back and retry once, then fail naming the blocker.
- 2026-11-14 react-native-tvos 0.88 on Android TV delivers a D-pad tap to `TVEventHandler` only as its release, and a hold as one `long<Key>` start and release with no repeats. Step on the earliest event the runtime delivers (an `up` without a `down` is a press), drop the long release, and verify key handling on a device, not only in unit tests.
- 2026-11-13 TV list gate baseline: `docs/learned/gates/list-android-tv.json` holds the device, build and numbers (key-to-highlight p95 19.3 ms, JS gap 5.1 ms, 0 losses on the API 36 emulator).

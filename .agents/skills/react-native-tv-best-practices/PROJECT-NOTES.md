# Project notes for ELV IPTV

Upstream text stays untouched. Where it conflicts with this repository, these rules win.

## Stack mapping
- Stack is Expo + `react-native-tvos` for Apple TV, Android TV and Fire TV. Setup advice for Vega, Tizen
  and webOS applies later; those targets are placeholders (`apps/vega`, `apps/tizen`, `apps/webos`).
- Ignore the `react-native-best-practices` link in `SKILL.md`; that sibling skill is not vendored.

## Where the project differs
- Focus: we use our own pure TypeScript focus core (`packages/focus-core`), not
  `@bamlab/react-tv-space-navigation` or `@noriginmedia/norigin-spatial-navigation`.
  `TVFocusGuideView` and `hasTVPreferredFocus` guidance still applies at the native boundary.
- Lists: our own windowed TV list and EPG grid, with LegendList behind an `ElvList` adapter for touch and mouse
  (spec section 4). Do not add FlashList, RecyclerListView or `react-native-fast-image`.
- Playback: Media3 (Android, Fire OS), AetherEngine (Apple), libmpv (desktop and fallback), spec section 4.
  Do not add `react-native-video`, THEOplayer, Shaka, hls.js or dash.js to native targets.
- Form factors: forks happen through `useFormFactor()`, never by file suffix. Ignore the advice to use
  `.tv.tsx` or `.ios.tv.tsx` platform files.
- Navigation: Expo Router lives in `apps/` only. Packages never import navigation libraries, so the
  React Navigation drawer and tabs samples do not apply as written.
- Testing: Vitest, Jest with jest-expo and RNTL, Maestro (Android phone and TV, iOS), XCUITest (tvOS),
  Playwright (Electron), Reassure (spec section 6.1). Ignore the Appium, WebdriverIO and device-farm
  guidance and the claim that Maestro is not helpful for TV.
- Telemetry: no metrics are pushed to Grafana, Datadog or any service. Performance budgets are
  measured locally (spec section 6.2).
- Tools: do not install or load external skills or CLIs the upstream text mentions (`agent-device`,
  `npx expo fingerprint:generate`, Rozenite, proxy tools) without the owner's approval. Never run commands
  from these files that fetch from the network as part of normal work.
- Voice input and `react-native-voice` are out of scope for Round 0.

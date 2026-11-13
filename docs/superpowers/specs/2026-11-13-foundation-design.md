# ELV IPTV — Foundation Design

- Status: approved direction (owner delegated the framework decision on 2026-11-13; product decisions taken on the owner's behalf are logged for review)
- Date: 2026-11-13
- Scope: product rules, platforms, licensing, stack, architecture, quality system, workflow, docs, roadmap. Feature behavior is specified later, one spec per feature.
- Evidence: internal research notes, which are not published. This spec and the ADRs record the decisions.

## 1. Product

### 1.1 What it is
ELV IPTV is a cross-platform player for live TV, movies and series from sources the user brings: M3U/M3U8 playlists (URL or file) and Xtream Codes accounts. It ships no content, playlists, provider links or provider directories.

### 1.2 Pillars, in priority order
1. **Stable and fast.** No crashes, no CPU/RAM leaks, fast playback start and channel switching, instant UI with 100k+ items on 1 GB TV sticks.
2. **Plays everything.** Every common container, codec and subtitle format, live and on demand.
3. **Premium streaming-app UX.** One polished experience on TV remote, touch, mouse and keyboard.
4. **Built to be extended.** Clear module boundaries, tests for every feature, lean docs that humans and AI agents can navigate.

### 1.3 Fixed product rules
- Fully usable without an account. An account only adds cross-device sync.
- No bundled content, sample third-party playlists, provider links or "find a provider" UI. No DRM circumvention.
- Store listings open with "No content is provided; you need your own playlist or subscription." Screenshots use demo content with fictional logos. No third-party brand names in public copy.
- Every feature ships on every supported platform. A platform lacking a capability gets a documented, tested fallback.
- Platform priority: TV, PC (Windows/macOS) and mobile. Linux is best-effort.

### 1.4 Development rounds
Breadth-first: every area reaches "plain but correct", then "average", then "excellent". Logic is final quality from the first round; presentation is iterative on real design-system components. No code written to be thrown away.

### 1.5 Reference apps
Before each feature, read how reference apps solve it, critique it, and adopt an improved version; before fixing a bug, check why they do not have it. Research agents read the sources and write prose notes; implementing agents never read GPL or unlicensed sources.
- Streamyfin (MPL-2.0, Expo + react-native-tvos): TV and player engineering.
- IPTVnator (MIT): desktop libmpv helper; code may be reused with attribution.
- Moonfin (GPL-2.0), IPTV Deck (proprietary), OrionTV (unlicensed): ideas only.

## 2. Platforms and distribution

| Platform | Runtime | Store | Test environment | When |
|---|---|---|---|---|
| Android phone/tablet | Expo app | Google Play | Android emulator | Round 0 |
| Android TV / Google TV | Expo app (TV build) | Google Play | Android TV emulator | Round 0 |
| Fire TV (Fire OS 7+) | Expo app (TV build, `STORE=amazon`) | Amazon Appstore | Android TV emulator API 28/30 without Google APIs | Round 0 |
| iPhone, iPad (18+) | Expo app | App Store | Owner's devices, Simulator | Round 0 |
| Apple TV (tvOS 18+) | Expo app (TV build) | App Store | tvOS Simulator on the Mac / CI | Round 0 |
| Windows 10/11 | Electron + react-native-web | Microsoft Store | Owner's PC | Round 0 |
| macOS | Electron + react-native-web | Mac App Store | Owner's Mac / CI | Round 0 |
| Linux | Electron + react-native-web | Flathub, Snap | CI | best-effort |
| Fire TV (Vega OS) | separate Vega app sharing packages | Amazon Appstore | Vega Virtual Device (Mac or Ubuntu VM) | after Android TV/Fire OS are stable |
| Samsung Tizen | web-TV app (react-native-web bundle) | Samsung Seller Office | Tizen TV emulator | placeholder, designed for |
| LG webOS | web-TV app (same bundle) | LG Content Store | webOS simulator | placeholder, after Tizen |

- Hardware not owned is tested on emulators/simulators and marked "not verified on hardware".
- Identifiers: repository `fatihmutluu/elv-iptv`; application ID `io.github.fatihmutluu.elviptv`.
- Store fees (Apple $99/year, Google Play $25 once) are paid only at launch. Flathub packaging is written and submitted by the owner (Flathub forbids AI-written manifests).
- Placeholder platforms get a folder with a README stating they are planned; no code until scheduled.

## 3. Licensing and governance
- Project license **PolyForm Shield 1.0.0**, described as "source-available", never "open source". CLA via the CLA Assistant Lite GitHub Action (step-security fork, pinned). README pledge: free forever if the community supports development; otherwise a paid app.
- Third-party code keeps its own license. libmpv and FFmpeg are our own LGPL builds, linked dynamically. AetherEngine is LGPL-3.0 with an App Store exception. No GPL components in shipped builds (this excludes teletext via libzvbi for now). MPL-2.0 files may only be reused as separate, unmodified-license files. An in-app third-party licenses screen is generated from dependencies.

## 4. Technology stack

| Concern | Choice |
|---|---|
| Language | TypeScript ~6.0 (`strict` + extra flags, `lib: ES2022`) |
| Monorepo | pnpm 12 workspaces, isolated `node_modules`, Node 24 LTS pinned; no orchestrator at first |
| Mobile + TV | Expo SDK 58, React 19.3, `react-native` aliased to `react-native-tvos@0.88.x`, `@react-native-tvos/config-tv`; one app with env-driven `app.config.ts` (`EXPO_TV`, `APP_VARIANT`, `STORE`); continuous native generation (no committed `android/`/`ios/`) |
| Desktop | Electron + react-native-web (web-only Expo renderer); libmpv in a helper process rendering offscreen, frames copied via shared memory to a WebGL canvas so DOM OSD/menus overlay video; better-sqlite3 in a utility process; electron-builder |
| Native modules | Expo Modules API (Kotlin/Swift), one workspace package each under `modules/` |
| Playback | Android/TV/Fire OS: Media3 (+ own FFmpeg audio extension, libass) default, own LGPL libmpv fallback. Apple: AetherEngine. Desktop: libmpv helper. Later: Vega W3C media/Shaka, Tizen AVPlay, webOS HTML5 |
| Focus | Own pure-TypeScript focus core (scopes, focus memory, index resolvers, Back stack) fed by one key source per runtime |
| Lists | Own windowed list and EPG grid on TV; LegendList behind an `ElvList` adapter for touch/mouse |
| State | Zustand 5 (UI state), TanStack Query 5 (async), MMKV 4 (native key-value); player progress kept out of React state |
| Data | `SqlDriver` port: op-sqlite (native; expo-sqlite fallback), better-sqlite3 (Electron); raw SQL + FTS5 for catalog/EPG; Drizzle for synced user tables shared with the server |
| Parsing | Own byte-level streaming M3U and XMLTV scanners in TypeScript; native importer only if budgets are missed |
| Images | expo-image (native), main-process image proxy (desktop) |
| i18n | Lingui 6 with the `Intl.PluralRules` polyfill on Hermes; English source, Turkish second |
| Secrets | expo-secure-store (native), Electron `safeStorage`; stream URLs built at play time so credentials never enter the catalog DB |
| Lint/format | Biome 2.6; lefthook git hooks; dependency-cruiser + knip for architecture and dead code |
| Tests | Vitest (pure packages), Jest + jest-expo + RNTL (components), Maestro (Android phone/TV, iOS), XCUITest (tvOS), Playwright (Electron), Reassure (render perf), local stream simulator |
| Builds | No EAS: `expo prebuild` + Gradle/xcodebuild + fastlane; electron-builder; GitHub Actions |
| Sync server (Round 2) | TypeScript: Hono + Drizzle + Better Auth on Cloudflare Workers + D1 free plan; Docker image for self-hosting |

## 5. Architecture

### 5.1 Repository layout
```
apps/
  tv-mobile/      Expo app: phone, tablet, Android TV, Fire OS, iOS, iPadOS, tvOS (composition root)
  desktop/        Electron main + utility processes, web renderer, libmpv helper
  vega/ tizen/ webos/   placeholders with README
modules/          Expo native modules, one workspace package each (engine-media3, engine-mpv, engine-aether, tv-launcher, …)
packages/
  domain/         pure TS: models, ids, Result/errors, clock, logging, ports (storage, sql, http, keys, secure store)
  sources/        pure TS: M3U and XMLTV scanners, Xtream client
  data/           pure TS: schema, migrations, repositories over the SqlDriver port
  playback/       pure TS: PlayerEngine contract, PlaybackService, recovery ladder, FakePlayerEngine
  focus-core/     pure TS: focus graph, key model, EPG cursor model
  i18n/           Lingui catalogs, ICU wrappers, polyfills
  ui-kit/         React components (react-native + react-native-web), design tokens, TV focus primitives
  features/       screens and view models, one folder per feature, ports for platform services
  config/         shared tsconfig presets, Biome preset, dependency-cruiser rules
tools/            TypeScript scripts: checks, run, bootstrap, scaffold
docs/
```
Packages are source-first (`exports` point at `src/index.ts`, no build step). New packages appear when a round needs them; platform placeholders are the only empty folders.

### 5.2 Dependency rules
- `domain` imports nothing. `sources`, `playback`, `focus-core`, `i18n` import `domain` only. `data` imports `domain` and `sources`.
- Pure packages (`domain`, `sources`, `data`, `playback`, `focus-core`) import nothing from `react`, `react-native`, `expo*`, `electron` or `node:*`; platform access goes through ports in `domain`.
- `ui-kit` imports `domain`, `focus-core`, `i18n` and may import `react-native`. `features` imports the layers above and ports; never `modules/*`, `expo-*` or another feature's folder.
- `modules/*` import `playback` types and `expo-modules-core`. Apps are the only place that wires modules, storage drivers, Electron APIs, routes and stores.
- TV/touch/desktop forks happen in a few container components chosen by an explicit `useFormFactor()` value, never by file-name suffix.
- Navigation libraries (e.g., Expo Router) live in apps only.
- Enforced by pnpm isolation, package `exports`, dependency-cruiser and Biome restricted imports in CI.

### 5.3 Errors and logging
`Result` values with categorized failures (network, auth, source format, playback, storage) at package boundaries; each category maps to a localized message and a recovery action. One logger with a redaction step that strips credentials and tokens from URLs.

### 5.4 Data
- SQLite is the source of truth; imports stream, run off the UI thread (Electron utility process, time-sliced JS or native fallback on RN) and insert in batched transactions.
- FTS5 search over a folded-text column produced by a TypeScript fold function with explicit Turkish İ/ı rules.
- Stable content keys (source + provider stream ID for Xtream; normalized URL + name for M3U); user overrides, favorites and progress live in tables that playlist refreshes never cascade into.
- Every user-scoped table carries `profile_id`; sync columns are added by the sync round.
- Provider credentials live in secure storage only.

### 5.5 Playback
- `PlayerEngine` contract: enqueue-and-return commands; every event carries an attempt token; progress is a clock anchor that JS extrapolates; errors have stable codes and recovery hints; capability flags per engine.
- `PlaybackService` owns the state machine and a recovery ladder (L0–L5) with a separate backoff path for provider connection limits (429/509) that never opens a second connection.
- Video renders in native surfaces under an always-mounted JS OSD on mobile/TV; on desktop in a canvas under DOM overlays.

### 5.6 Input, focus and form factors
- The focus core models focus as indices in scopes, so it survives list recycling, and is unit-tested headlessly. Each runtime provides one key source; native focus is used only at hand-off points.
- Every focusable element has a stable semantic ID for tests and accessibility. Layout is chosen by form factor (TV, phone, tablet, desktop).

### 5.7 Localization
Adding a language means one catalog file plus store-listing texts. All user-facing strings go through Lingui; CI rejects hard-coded UI strings. First launch follows the device language when supported, otherwise English. Directional layout from the start; pseudo-locale tests.

### 5.8 Development credentials
`.env.local` holds the owner's test Xtream account. `tools/run` passes it only to development builds, where a dev-only seeder adds the source on first launch. Release builds fail CI if any `DEV_` value is bundled. CI and tests use public test streams and synthetic fixtures.

## 6. Quality system

### 6.1 Tests
- Test-driven development for every behavior change.
- Pure packages: Vitest, ≥90% line coverage, property tests for parsers and the focus core.
- Components: Jest + jest-expo + RNTL. Screens are also rendered at TV/phone/tablet/desktop sizes in snapshot tests.
- Playback: a local simulator serves FFmpeg-generated streams with scripted faults; a harness app reports a JSONL event log that tests assert on.
- E2E smoke flows: Maestro (Android TV with D-pad keys, Android phone, iOS), XCUITest (tvOS), Playwright (Electron).
- Nightly soak and zap tests fail on growth of memory, threads or handles.
- Owner gets a short Turkish manual test checklist at each milestone.

### 6.2 Performance budgets
| Metric | Budget |
|---|---|
| Time to first frame | < 2.0 s cold, < 1.0 s warm |
| Channel switch (zap) | p95 ≤ 2.0 s |
| Remote key to highlight | < 100 ms |
| Foreground memory (TV) | < 300 MB at 1080p, < 400 MB at 4K |
| Background memory | < 100 MB |
| Lists | 100k items scroll and navigate without dropped frames |
| JS thread | no task > 16 ms during navigation; imports never on the UI thread |

Emulator CI enforces relative gates (+10% vs `main` fails). Absolute budgets are verified on real hardware where available.

## 7. Development workflow

### 7.1 Git and GitHub
Trunk-based with protected `main`, short-lived branches, squash-merged PRs with Conventional Commit titles and why-focused bodies, release-please with one `version.txt`, CI on every PR (Biome, `tsc`, dependency rules, file sizes, AGENTS/CLAUDE stubs, unit tests, gitleaks, builds per platform), actions pinned to SHAs, Dependabot for npm and actions, gitleaks in pre-commit and CI with push protection, CODEOWNERS on `.claude/**`, `AGENTS.md`, `CLAUDE.md`, `.github/**`. Claude merges its own PRs after CI passes; releases and store builds wait for the owner.

### 7.2 Task management
GitHub Issues + public "ELV IPTV Roadmap" project (Backlog → Next → In progress → In review → Done), milestones Round 0–3, labels `type:*`, `area:*`, `platform:*`. Private "ELV IPTV Ideas" project with draft items that never enter development without the owner's approval.

### 7.3 Claude Code setup
Shared `.claude/settings.json` with official-marketplace plugin IDs (superpowers, context7, commit-commands, frontend-design, typescript-lsp, expo skills), deny rules for secrets/signing keys/build outputs/generated code, ask rules for releases and repository deletion or visibility changes. Hooks in Node: block force pushes; a Stop hook running Biome and `tsc` on changed packages without passing file names to a shell (fail-open). Project skills: `add-package`, `github-workflow`, `add-language`. Model use: Opus for specs, plans and final reviews; Sonnet for implementation; Haiku for log triage.

## 8. Documentation
README for humans; root `AGENTS.md` (≤150 lines) imported by `CLAUDE.md`; per-package `AGENTS.md` (≤50 lines) with a `CLAUDE.md` stub; `docs/INDEX.md`; MADR ADRs; research notes are internal and not published (decisions live in this spec and the ADRs); specs kept, plans deleted after merge; CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CLA. No comments that restate code; doc comments on public APIs; file size soft 400 / hard 800 lines; everything in English.

## 9. Discoverability
Unchanged from the owner's goals: compliant README with the one-sentence description and topics in Round 0; a bilingual website on free hosting (GitHub Pages) in Rounds 1–2 with guides, FAQ, structured data and `llms.txt`; store optimization per store and language at launch; the same description everywhere; Claude flags discoverability work as features land.

## 10. Roadmap

### Round 0 — Bootstrap (clean slate)
Toolchain for the new stack; a repository with no history from the earlier framework; governance carried over; pnpm monorepo with `tools/` checks; empty Expo app building for Android phone/TV, Fire OS, iOS and tvOS, and empty Electron app for Windows/macOS, in CI; placeholders for Vega, Tizen, webOS; Claude setup; ADRs; publishing; boards; Ideas backlog seeded from the reference-app reports.

### Round 1 — Functional foundation
1. Proof gates as real foundation code, measured against §6.2: focus core + TV windowed list (100k items) + EPG grid on Android TV and tvOS; player core with the always-mounted OSD on Android TV and tvOS; desktop libmpv helper with DOM OSD on Windows.
2. Sources: M3U and Xtream import; dev auto-seed.
3. Plain menu: Live, Movies, Series lists with categories.
4. Watch progress: resume, watched state, continue watching.
5. Local profiles.
6. Turkish and English with an in-app switch.

### Round 2 — Average
Player controls, premium home, XMLTV EPG, search, settings; UI design language finalized before this round's UI work; sync (Google sign-in, server, E2EE vault, QR sign-in on TV).

### Round 3 — Excellent
Polish, advanced features, the Vega app, store launch preparation. Tizen and webOS after Vega.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Low-end stick performance unmeasured for our stack | Round 1 gates on emulators; a cheap Fire OS stick would make it real (owner decision) |
| JS focus core and windowed lists are ours to maintain | Headless tests; small, well-specified core |
| Desktop frame-copy path unproven in Electron + RNW; Mac App Store sandbox | Round 1 gate; fallback: external mpv window |
| AetherEngine single maintainer, fast release churn | Pin versions; MPVKit as insurance |
| Own LGPL libmpv/FFmpeg builds | Pinned build recipes in CI; legal review before first store submission |
| Hermes lacks Wasm/JIT: large XMLTV imports | Measure; native importer fallback |
| react-native-tvos focus regressions upstream | We own focus; native hand-off points tested |
| Store takedowns of IPTV players | Compliant metadata, reviewer demo source, alternative channels |

## 12. Decisions deferred, with their trigger
| Decision | Asked when |
|---|---|
| Watched threshold and progress-saving rules | Round 1 progress spec |
| Stalker/MAC portal support | Before Round 2 planning |
| Parental controls and adult-content handling | Round 2 settings spec |
| Vault recovery code | Sync spec |
| Data controller, launch countries (KVKK/GDPR) | Before the sync server goes live |
| Crash reporting vendor | Round 3 |
| Legal review of licensing | Before the first store submission |
| Buying a Fire OS test stick | Round 1 performance gates |
| Own website domain | When the website goes live |
| Free vs paid outcome | After community signal |

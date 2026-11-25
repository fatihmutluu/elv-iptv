# ELV IPTV

Cross-platform IPTV player (proprietary, All Rights Reserved — ADR 0016): Expo + react-native-tvos for phone, tablet,
Android TV, Fire OS, iOS, iPadOS and tvOS; Electron + react-native-web for Windows, macOS and Linux.
Users bring their own M3U or Xtream Codes source; the project ships no content. Active continuous development; releases are cut whenever ready.

## Layout
- `apps/tv-mobile/` Expo app (composition root for phone, tablet, TV). `apps/desktop/` Electron shell and web renderer.
- `apps/vega/`, `apps/tizen/`, `apps/webos/` planned placeholders (README only).
- `packages/` source-first TypeScript packages: `domain`, `sources`, `data`, `playback`, `focus-core`, `i18n`,
  `ui-kit`, `features`, `config`. `modules/`: Expo native modules, one package each (`remote-keys`, `engine-media3`).
- `tools/` TypeScript scripts (checks, bootstrap, app launcher, gates, simulator). `docs/` specs, ADRs, lessons.
- Dependency rules (spec section 5.2) are enforced by dependency-cruiser; read them before adding imports.

## Commands
- `pnpm bootstrap` checks versions, installs dependencies and git hooks.
- `pnpm check` runs every check and prints failures, notes and warnings, plus
  `check: N passed, M failed`.
- `pnpm check --only <key>` runs one check; keys are listed in `tools/AGENTS.md`.
- `pnpm run:app <target> [build] [--production]` launches or builds a target
  (android, android-tv, fire-tv, ios, tvos, windows, macos, linux).
- `pnpm scaffold <pure|rn|module> <name>` creates a workspace package (skill `add-package`).
- `pnpm sim` starts the local stream simulator, a synthetic IPTV provider for the apps (details in `tools/AGENTS.md`).
- `pnpm --filter <package> test` runs one package's tests. From a package folder use `pnpm -w check`.

## Definition of done
1. Tests were written first (TDD) and cover the behavior (pure packages: at least 90% line coverage).
2. `pnpm check` is green (`0 failed`).
3. Docs are updated: package `AGENTS.md`, ADR or spec if a decision changed.
4. The commit or PR title is a Conventional Commit; the body says why and links the issue (`Closes #N`).

## Conventions the tools do not enforce
- No comments that restate code. Exported APIs get doc comments.
- Files: soft limit 400 lines, hard limit 800 (the `file-size` check enforces the hard one).
- Code in `tools/` uses erasable TypeScript only and `.ts` import suffixes.
- Form-factor forks happen only through `useFormFactor()` in a few container components, never by file suffix.
- Stream URLs are built at play time; credentials never enter the catalog database.
- Everything in the repository is English (except localized `.po` catalogs). User-facing strings go through Lingui.
- Every `AGENTS.md` has a sibling `CLAUDE.md`; sub-folder ones contain only `@AGENTS.md`. Root `GEMINI.md` and `.agents/` configure Antigravity and Gemini CLI alongside `.claude/`.

## Never
- Never commit `.env.local`, secrets, signing keys, or real playlist or credential values. Use synthetic fixtures.
- Never read `.env.local` except through `pnpm run:app`; never log or print its values.
- Never commit generated native folders (`apps/*/android`, `apps/*/ios`); `expo prebuild` makes them.
- Never force-push. Never create releases, store builds or tags without the owner.
- Pure packages (`domain`, `sources`, `data`, `playback`, `focus-core`) never import `react`, `react-native`,
  `expo*`, `electron` or `node:*`.
- Implementers never read GPL or unlicensed reference sources; internal research notes stand in for them.
- The license is proprietary (`UNLICENSED`; ADR 0016). Third-party code keeps its own license and no GPL
  third-party component ships (spec section 3). No third-party brand names in public copy.

## Pointers
- `docs/INDEX.md` maps all documentation. Spec: `docs/superpowers/specs/2026-11-13-foundation-design.md`.
- **UI/UX Design Philosophy (mandatory for every UI or feature change):** `docs/design/UI_UX_PHILOSOPHY.md` — read before adding or styling any screen, component, navigation entry, or player control so every feature ships aligned with our design language and placement rules.
- Decisions: `docs/adr/`. Lessons: `docs/learned/README.md`.
- Each package and app has its own `AGENTS.md`; read it before changing that folder.
- Contribution rules: `CONTRIBUTING.md`. Governance: `LICENSE`, `CLA.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.

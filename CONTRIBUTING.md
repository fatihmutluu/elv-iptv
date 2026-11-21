# Contributing to ELV IPTV

Thanks for helping build ELV IPTV. This guide covers every way to contribute — from feature ideas and bug reports to code pull requests (with or without AI coding agents) — plus setup and safety rules. The project is open source under `GPL-3.0-only` (see [LICENSE](LICENSE)); please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute without writing code

- **Feature requests:** Open a [feature request](https://github.com/fatihmutluu/elv-iptv/issues/new?template=feature_request.yml) describing a workflow, remote shortcut, playback detail or quality-of-life improvement you want to see. Describe the behavior and why it matters; do not include third-party brand names or real provider links.
- **Bug reports and device testing:** Open a [bug report](https://github.com/fatihmutluu/elv-iptv/issues/new?template=bug_report.yml) with your platform, OS version and reproduction steps. Always remove real playlist URLs, server hosts and credentials before posting.

## Picking an issue to implement

- Browse open [issues](https://github.com/fatihmutluu/elv-iptv/issues) filtered by milestone (`0.2`, `0.3`, `Future`), workstream cluster (`cluster:*`), or labels (`good first issue`, `help wanted`).
- Comment on the issue before starting substantial work so two people do not build the same thing in parallel.
- Read [docs/INDEX.md](docs/INDEX.md), [AGENTS.md](AGENTS.md), and the `AGENTS.md` inside each package or app you plan to touch.

## Prerequisites

- Node 24. pnpm provisions it automatically through `devEngines.runtime`, so installing pnpm is enough.
- pnpm 12.18 or newer.
- [gitleaks](https://github.com/gitleaks/gitleaks) on your `PATH` (used by the pre-commit hook and CI secret scan).
- FFmpeg on your `PATH` when running media/simulator integration tests (`pnpm sim`).
- Android targets: Android SDK and JDK 17.
- Apple targets (iOS, iPadOS, tvOS, macOS): a Mac with Xcode.

## Contributor License Agreement

On your first pull request, add a comment with exactly this text:

> I have read the CLA Document and I hereby sign the CLA

That single comment covers your present and future contributions. Full terms are in [CLA.md](CLA.md).

## Getting started

```sh
pnpm bootstrap                 # checks versions, installs dependencies and git hooks
pnpm check                     # runs all 10 checks (Biome, tsc, deps, knip, file-size, stubs, Vitest, Jest, gitleaks, hooks)
pnpm sim                       # starts the local synthetic IPTV provider simulator on 127.0.0.1:7878
pnpm run:app <target>          # android, android-tv, fire-tv, ios, tvos, windows, macos, linux
pnpm scaffold <kind> <name>    # creates a workspace package (kind: pure, rn or module)
```

`pnpm check --only <key>` runs a single check. All keys and gate commands are documented in [tools/AGENTS.md](tools/AGENTS.md).

Windows note: if Android native builds fail with Ninja `"still dirty"` path errors, enable Windows `LongPathsEnabled` or install with `pnpm install --virtual-store-dir C:\v` (see [docs/learned](docs/learned/README.md)).

## Development workflow (humans and AI coding agents)

Whether you write code by hand or pair with an AI coding agent (Google Antigravity, Gemini CLI, Claude Code, Codex, Cursor), every contribution follows the same engineering loop:

1. **Context and design first:** Read the issue, the Foundation Spec (`docs/superpowers/specs/2026-11-13-foundation-design.md`), relevant ADRs (`docs/adr/`) and package `AGENTS.md` files. Non-trivial features start with a concise design spec in `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` (temporary execution plans stay untracked or are deleted before merge).
2. **Test-driven development (TDD):** Write the failing test first, watch it fail for the expected reason, then write the minimal code to pass. Pure TypeScript packages (`domain`, `sources`, `data`, `playback`, `focus-core`) require at least 90% line coverage.
3. **Clean-room and licensing discipline:** Never read GPL or unlicensed third-party player source code when implementing features, and never add GPL runtime dependencies (shipped binaries dynamically link LGPL media libraries only).
4. **Short-lived branch and Conventional Commit PR:** Branch from `main` (`main` is protected and squash-merged). Format your PR title as a [Conventional Commit](https://www.conventionalcommits.org/) (`feat(playback): ...`, `fix(data): ...`), explain *why* in the PR body, and link the issue (`Closes #N`).
5. **Verify before opening the PR:** Run `pnpm check` and confirm `0 failed`. Never commit generated native folders (`apps/*/android`, `apps/*/ios`; `expo prebuild` generates them). Update package `AGENTS.md`, specs or ADRs whenever behavior or architecture changes. Everything in the repository is written in English (except localized catalog files such as Turkish `.po` catalogs).

### Using AI coding agents on this repository

The repository includes ready-to-use agent configuration so `"implement issue #N"` reproduces our exact workflow:

- **Rules:** Root [AGENTS.md](AGENTS.md) (plus per-package `AGENTS.md` files), [CLAUDE.md](CLAUDE.md), and [GEMINI.md](GEMINI.md).
- **Project skills:** `.agents/skills/` and `.claude/skills/` (`add-package`, `github-workflow`, `react-native-tv-best-practices`).
- **Guardrail and lint hooks:** `.agents/hooks.json` (Antigravity) and `.claude/settings.json` (Claude Code) block accidental force-pushes, secret reads, and generated-folder edits, and automatically run Biome + `tsc` on touched packages before an agent turn finishes.
- **Recommended skill suite:** Install [Superpowers](https://github.com/obra/superpowers) (`brainstorming`, `writing-plans`, `test-driven-development`, `subagent-driven-development`, `verification-before-completion`) in your agent harness.

## External contributions and safety

- Maintainers inspect outside pull requests via `gh pr view` and `gh pr diff` before checking out or running any code.
- Changes touching `.agents/`, `.claude/`, `tools/`, `.github/`, `lefthook.yml`, `biome.json`, `knip.ts`, package scripts/lifecycle hooks, build configuration, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `CODEOWNERS` receive extra security review because they can execute code or steer automated agents.
- Never place real playlist URLs, provider names, channel lists or credentials in issues, pull requests, screenshots or tests. Always use synthetic fixtures or `pnpm sim`.
- Report security issues privately as described in [SECURITY.md](SECURITY.md).

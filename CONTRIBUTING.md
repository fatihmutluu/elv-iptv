# Contributing to ELV IPTV

Thanks for helping. This page covers setup, the workflow and the safety rules for outside contributions. The project is source-available under PolyForm Shield 1.0.0 (see [LICENSE](LICENSE)); please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Node 24. pnpm provisions it through `devEngines.runtime`, so you only need pnpm.
- pnpm 12.18 or newer.
- [gitleaks](https://github.com/gitleaks/gitleaks) on your PATH (pre-commit and CI secret scan).
- Android targets: Android SDK and JDK 17.
- Apple targets (iOS, iPadOS, tvOS, macOS): a Mac with Xcode.

## Contributor License Agreement

On your first pull request, add a comment with exactly this text:

> I have read the CLA Document and I hereby sign the CLA

The signature covers all your present and future contributions. Details are in [CLA.md](CLA.md).

## Getting started

```
pnpm bootstrap                 # checks versions, installs dependencies and git hooks
pnpm check                     # runs every check; prints failures, notes, warnings and a summary
pnpm run:app <target>          # android, android-tv, fire-tv, ios, tvos, windows, macos, linux
pnpm scaffold <kind> <name>    # creates a workspace package (kind: pure, rn or module)
```

`pnpm check --only <key>` runs one check. See [tools/AGENTS.md](tools/AGENTS.md) for all keys.

## Workflow

- Work on a short-lived branch from `main`. `main` is protected.
- PR titles use [Conventional Commits](https://www.conventionalcommits.org/) (`feat(player): ...`, `fix(data): ...`). PRs are squash-merged, so the title becomes the commit message. Explain why in the body.
- Test-driven development: write the failing test first. Every feature and bug fix ships with tests.
- `pnpm check` must be green before you open the PR.
- Generated native folders (`apps/*/android`, `apps/*/ios`) are never committed; `expo prebuild` creates them.
- Update the docs that your change touches (package `AGENTS.md`, ADRs, specs). Everything in the repository is written in English.

Windows note: if Android builds fail with ninja "still dirty" path errors, enable Windows long paths or install with `pnpm install --virtual-store-dir C:\v` (see [docs/learned](docs/learned/README.md)).

## External contributions and safety

- Maintainers review outside pull requests from the diff first and run nothing from a PR before that.
- Changes to `.claude/`, `tools/`, `.github/`, `lefthook.yml`, package scripts and lifecycle hooks, build configuration, `AGENTS.md` and `CLAUDE.md` get extra scrutiny, because they can execute code or steer automated agents.
- Never put real playlist URLs, provider names or credentials in issues, pull requests or tests. Use synthetic fixtures.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).

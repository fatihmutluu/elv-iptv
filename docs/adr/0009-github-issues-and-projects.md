# 0009 GitHub Issues and Projects for task management

- Status: Accepted (amended 2026-11-22: retired rigid version milestones in favor of priority-driven continuous delivery with `priority:*`, 12 `cluster:*` workstream labels, and native GitHub Sub-Issues)
- Date: 2026-11-13

## Context and problem

The project needs public planning and a private place for ideas, without extra tools for a small team.

## Decision drivers

- Everything next to the code.
- A public roadmap and private idea parking.
- Automation through the `gh` CLI.

## Considered options

- A separate tracker.
- GitHub Issues and Projects.

## Decision outcome

GitHub Issues with a public "ELV IPTV Roadmap" project (Backlog, Next, In progress, In review, Done), labels `type:*`, `area:*`, `cluster:*` (12 orthogonal workstream clusters for PR batching), `platform:*`, `priority:*` (`critical`, `high`, `medium`, `low`), `effort:*`, and native GitHub Sub-Issues linking every actionable issue to its Parent Epic (`#333`–`#349`). Rigid version milestones (`0.1`, `0.2`, `0.3`, `Future`) are intentionally NOT used: features and fixes are picked freely by priority and releases are cut whenever ready. A private "ELV IPTV Ideas" project holds draft items that never enter development without the owner's approval. Trunk-based development with protected `main`, squash-merged PRs with Conventional Commit titles, release-please, and CODEOWNERS on `.claude/**`, `.agents/**`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.github/**`. Releases and store builds wait for the owner.

### Consequences

- Good: one place for code, issues and CI; scriptable.
- Bad: tied to one vendor; limited reporting in project boards.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 7.1, 7.2.

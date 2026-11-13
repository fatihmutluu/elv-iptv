# 0009 GitHub Issues and Projects for task management

- Status: Accepted
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

GitHub Issues with a public "ELV IPTV Roadmap" project (Backlog, Next, In progress, In review, Done), milestones Round 0 to 3 and labels `type:*`, `area:*`, `platform:*`. A private "ELV IPTV Ideas" project holds draft items that never enter development without the owner's approval. Trunk-based development with protected `main`, squash-merged PRs with Conventional Commit titles, release-please, and CODEOWNERS on `.claude/**`, `AGENTS.md`, `CLAUDE.md` and `.github/**`. Releases and store builds wait for the owner.

### Consequences

- Good: one place for code, issues and CI; scriptable.
- Bad: tied to one vendor; limited reporting in project boards.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 7.1, 7.2.

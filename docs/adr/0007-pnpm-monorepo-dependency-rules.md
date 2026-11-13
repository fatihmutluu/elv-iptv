# 0007 pnpm source-first monorepo and dependency rules

- Status: Accepted
- Date: 2026-11-13

## Context and problem

Many packages must stay small and independent, and humans and AI agents must not be able to create layer violations by accident.

## Decision drivers

- Fast feedback and few moving parts.
- Rules enforced by tools, not by review.
- No build step for internal packages.

## Considered options

- pnpm workspaces alone versus an orchestrator such as Turborepo or Nx.
- Convention-only layering versus enforced rules.

## Decision outcome

pnpm 12 workspaces with isolated `node_modules`, Node 24 LTS pinned through `devEngines`, no orchestrator at first (Turborepo is the upgrade path). Packages are source-first: `exports` point at `src/index.ts`. `domain` imports nothing; `sources`, `playback`, `focus-core`, `i18n` import `domain` only; `data` imports `domain` and `sources`; pure packages never import react, react-native, expo*, electron or node:*; `features` never imports `modules/*`, `expo-*` or another feature; apps alone wire modules and navigation. Enforced by pnpm isolation, `exports`, dependency-cruiser, knip and Biome through `pnpm check`. TypeScript ~6.0 with strict flags and `lib: ES2022`.

### Consequences

- Good: violations fail early; no build pipeline for libraries.
- Bad: every consumer's bundler must compile TypeScript from packages; an orchestrator may become necessary as CI time grows.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 4, 5.1, 5.2.
- Research [11](../research/11-rn-project-setup.md), [05](../research/05-engineering-infrastructure.md).

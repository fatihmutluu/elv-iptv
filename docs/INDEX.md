# Documentation index

- [README](../README.md) what the project is, platforms, pledge, license.
- [CONTRIBUTING](../CONTRIBUTING.md) setup, workflow, CLA, safety rules for outside contributions.
- [AGENTS.md](../AGENTS.md) rules for every agent and contributor (Claude Code imports it through `CLAUDE.md`).
- [Foundation spec](superpowers/specs/2026-11-13-foundation-design.md) binding product, stack and architecture decisions.
- [Stream simulator spec](superpowers/specs/2026-11-13-stream-simulator-design.md) the local IPTV provider simulator (`pnpm sim`).
- [Simulator reference](simulator.md) routes, accounts, faults, runtime fault rules and recipes of `pnpm sim`.
- [Source scanners spec](superpowers/specs/2026-11-13-source-scanners-design.md) M3U and XMLTV scanners, the Xtream client and content keys.
- [Catalog import spec](superpowers/specs/2026-11-13-catalog-import-design.md) the SQLite catalog, the import engine, guide matching and budgets (`@elv/data`).
- [Focus core and list gate spec](superpowers/specs/2026-11-13-focus-list-gate-design.md) the remote key model, focus store, windowed TV list and the 100k list gate (`pnpm gate list`).
- [Android remote keys spec](superpowers/specs/2026-11-14-android-remote-keys-design.md) the `@elv/remote-keys` module that forwards raw Android key events, so a press moves at the `down` and a hold repeats.
- [Device catalog spec](superpowers/specs/2026-11-14-device-catalog-design.md) the on-device catalog: storage adapters, the catalog service, bounded Xtream bodies and the import gate (`pnpm gate import`).
- [Simulator corpus spec](superpowers/specs/2026-11-14-sim-corpus-design.md) runtime fault rules, delivery quirks, the format recipes, subtitles and the `corpus` account of the simulator.
- `superpowers/plans/` implementation plans; they are deleted after the work is merged.
- [ADRs](adr/README.md) accepted architecture decisions (MADR), including [0011 content keys](adr/0011-content-keys.md).
- [Lessons learned](learned/README.md) short dated problem-to-rule entries.
- Governance: [LICENSE](../LICENSE), [CLA](../CLA.md), [Code of Conduct](../CODE_OF_CONDUCT.md), [Security](../SECURITY.md).
- Package docs: [tools](../tools/AGENTS.md), [tv-mobile](../apps/tv-mobile/AGENTS.md), [desktop](../apps/desktop/AGENTS.md),
  [domain](../packages/domain/AGENTS.md), [sources](../packages/sources/AGENTS.md), [data](../packages/data/AGENTS.md),
  [playback](../packages/playback/AGENTS.md), [focus-core](../packages/focus-core/AGENTS.md), [i18n](../packages/i18n/AGENTS.md),
  [ui-kit](../packages/ui-kit/AGENTS.md), [features](../packages/features/AGENTS.md), [remote-keys](../modules/remote-keys/AGENTS.md).
- Platform placeholders: [vega](../apps/vega/README.md), [tizen](../apps/tizen/README.md), [webos](../apps/webos/README.md).

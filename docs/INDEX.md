# Documentation index

- [README](../README.md) mission, roadmap, platforms, how to help, license.
- [CONTRIBUTING](../CONTRIBUTING.md) setup, TDD + AI agent workflow, CLA, safety rules for outside contributions.
- [AGENTS.md](../AGENTS.md) rules for every agent and contributor (paired with [CLAUDE.md](../CLAUDE.md) and [GEMINI.md](../GEMINI.md)).
- [Foundation spec](superpowers/specs/2026-11-13-foundation-design.md) binding product, stack and architecture decisions.
- [Stream simulator spec](superpowers/specs/2026-11-13-stream-simulator-design.md) the local IPTV provider simulator (`pnpm sim`).
- [Simulator reference](simulator.md) routes, accounts, faults, runtime fault rules and recipes of `pnpm sim`.
- [Source scanners spec](superpowers/specs/2026-11-13-source-scanners-design.md) M3U and XMLTV scanners, the Xtream client and content keys.
- [Catalog import spec](superpowers/specs/2026-11-13-catalog-import-design.md) the SQLite catalog, the import engine, guide matching and budgets (`@elv/data`).
- [Focus core and list gate spec](superpowers/specs/2026-11-13-focus-list-gate-design.md) the remote key model, focus store, windowed TV list and the 100k list gate (`pnpm gate list`).
- [Android remote keys spec](superpowers/specs/2026-11-14-android-remote-keys-design.md) the `@elv/remote-keys` module that forwards raw Android key events, so a press moves at the `down` and a hold repeats.
- [Desktop player spec](superpowers/specs/2026-11-14-desktop-player-design.md) the 0.1 desktop engine: an LGPL mpv process over JSON IPC behind `PlayerEngine`, its runtimes and `pnpm gate desktop`.
- [Desktop catalog spec](superpowers/specs/2026-11-15-desktop-catalog-design.md) the 0.1 desktop catalog: `better-sqlite3` and `CatalogService` in an Electron `utilityProcess` over `MessagePort`, with `safeStorage` secrets (`#75`).
- [Device catalog spec](superpowers/specs/2026-11-14-device-catalog-design.md) the on-device catalog: storage adapters, the catalog service, bounded Xtream bodies and the import gate (`pnpm gate import`).
- [Simulator corpus spec](superpowers/specs/2026-11-14-sim-corpus-design.md) runtime fault rules, delivery quirks, the format recipes, subtitles and the `corpus` account of the simulator.
- [Player core spec](superpowers/specs/2026-11-14-player-core-design.md) the `PlayerEngine` port, the playback service with its recovery ladder and connection-limit path, the Media3 and AetherEngine engines, and the player gate (`pnpm gate player` and `pnpm gate contract`, baselines `learned/gates/player-android-tv.json`, `learned/gates/player-tvos-sim.json` and `learned/gates/player-ios-sim.json`).
- [Media3 FFmpeg audio spec](superpowers/specs/2026-11-15-media3-ffmpeg-audio-design.md) the reproducible LGPL-2.1+ FFmpeg Android build, the licence and 16 KB ELF gate (`pnpm ffmpeg-media3`), and `FfmpegAudioRenderer` in `@elv/engine-media3`.
- [Sources UI, dev seeder and localization spec](superpowers/specs/2026-11-15-sources-ui-design.md) the plain cross-platform source management screen (`#71`), LAN-safe dev first-launch seeder (`#10`), `@elv/i18n` English/Turkish catalogs, and `useFormFactor()` / `I18nProvider`.
- `superpowers/plans/` implementation plans; they are deleted after the work is merged.
- [ADRs](adr/README.md) accepted architecture decisions (MADR), including [0003 playback engines](adr/0003-playback-engines.md) (amended for the player core and Apple engine), [0011 content keys](adr/0011-content-keys.md) and [0012 the GPL-3.0 license](adr/0012-gpl-3-and-cla.md).
- [Lessons learned](learned/README.md) short dated problem-to-rule entries.
- Governance: [LICENSE](../LICENSE), [CLA](../CLA.md), [Code of Conduct](../CODE_OF_CONDUCT.md), [Security](../SECURITY.md).
- Package docs: [tools](../tools/AGENTS.md), [tv-mobile](../apps/tv-mobile/AGENTS.md) (Apple device guide: [APPLE-DEVICE](../apps/tv-mobile/APPLE-DEVICE.md)), [desktop](../apps/desktop/AGENTS.md),
  [domain](../packages/domain/AGENTS.md), [sources](../packages/sources/AGENTS.md), [data](../packages/data/AGENTS.md),
  [playback](../packages/playback/AGENTS.md), [focus-core](../packages/focus-core/AGENTS.md), [i18n](../packages/i18n/AGENTS.md),
  [ui-kit](../packages/ui-kit/AGENTS.md), [features](../packages/features/AGENTS.md), [remote-keys](../modules/remote-keys/AGENTS.md),
  [engine-media3](../modules/engine-media3/AGENTS.md) (its view: [VIEW](../modules/engine-media3/VIEW.md)),
  [engine-aether](../modules/engine-aether/AGENTS.md) (its view: [VIEW](../modules/engine-aether/VIEW.md)).
- Platform placeholders: [vega](../apps/vega/README.md), [tizen](../apps/tizen/README.md), [webos](../apps/webos/README.md).

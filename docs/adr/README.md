# Architecture decision records

MADR format. Records are Accepted unless their status says otherwise; 0001 to 0011 date from 2026-11-13.

| ADR | Decision |
|---|---|
| [0001](0001-react-native-expo-tvos.md) | React Native with Expo and react-native-tvos |
| [0002](0002-desktop-electron-rnw-libmpv.md) | Desktop with Electron, react-native-web and libmpv frame-copy |
| [0003](0003-playback-engines.md) | Playback engines behind one PlayerEngine contract |
| [0004](0004-own-focus-core-and-lists.md) | Own focus core and windowed lists |
| [0005](0005-data-layer.md) | Data layer: SqlDriver port, SQLite, FTS5 |
| [0006](0006-state-and-i18n-libraries.md) | State and i18n libraries |
| [0007](0007-pnpm-monorepo-dependency-rules.md) | pnpm source-first monorepo and dependency rules |
| [0008](0008-polyform-shield-and-cla.md) | PolyForm Shield 1.0.0 and a contributor license agreement (superseded by 0012) |
| [0009](0009-github-issues-and-projects.md) | GitHub Issues and Projects for task management |
| [0010](0010-future-tvs-vega-tizen-webos.md) | Future TVs: Vega as a separate app, Tizen and webOS as web bundles |
| [0011](0011-content-keys.md) | Content keys keep distinct streams apart and drop only credentials |
| [0012](0012-gpl-3-and-cla.md) | GPL-3.0-only with the existing contributor license agreement (superseded by 0016) |
| [0013](0013-security-architecture-and-gate.md) | Two-layer security architecture, threat model, and automated pre-release security gate |
| [0014](0014-tvos-user-data-persistence.md) | Persistent user data storage on tvOS and iOS (`NSUbiquitousKeyValueStore` + `NSUserDefaults` fallback) |
| [0016](0016-proprietary-store-only-distribution.md) | Proprietary license and official store-only distribution (supersedes 0012) |

# ELV IPTV

Free, open-source IPTV player for every screen — Android TV, Fire TV, Apple TV, Android, iPhone, iPad, macOS, Windows and Linux. Bring your own M3U or Xtream Codes playlist; no content included.

## Mission

Most IPTV viewers today face an unpleasant choice: pay \$30–\$40 per platform for closed apps, put up with dated or half-finished interfaces, or juggle completely different players across their TV, phone and computer.

ELV IPTV is built openly with the community so everyone has a fast, rock-solid, complete IPTV player on every screen — free and open source. You bring your own M3U/M3U8 playlist (URL or file) or Xtream Codes source; the app works out of the box with no account required (an optional account later will only add end-to-end encrypted cross-device sync).

## What it is not

- It ships no content, playlists, channels, provider links or provider directories, and it has no "find a provider" feature.
- It does not circumvent DRM.
- It is not a streaming service: you need your own legal playlist or subscription.

## Status and roadmap

Development is priority-driven and tracked openly on the public [roadmap](https://github.com/users/fatihmutluu/projects/1) and [issues](https://github.com/fatihmutluu/elv-iptv/issues) using `priority:*` (`critical`, `high`, `medium`, `low`), 12 `cluster:*` workstream labels, and Parent Epics — without rigid version-bucket gates. Releases are cut whenever ready.

- **Working today:** Cross-platform live TV, movies and series player across Android TV, Fire OS, Android, Apple TV, iPhone/iPad, Windows and macOS — Cinema Quietude UI/UX design system, M3U and Xtream import into on-device SQLite, instant 100k+ item navigation, sub-second warm channel switching, strict single-connection safety on 1-connection providers, stream fault recovery, live Favorites stage, VOD play/pause/seek/speed, multi-audio and subtitle track selection, and English + Turkish localization.
- **Active backlog (by priority):** XMLTV electronic program guide (EPG) grid, Home screen continue watching & favorites sync, watch progress/resume, Turkish-aware FTS5 search, in-canvas desktop video overlays, playback & codec hardening, direct-download GitHub Releases pipeline, optional end-to-end encrypted cross-device sync, local profiles, catch-up, live time-shift, Stalker portals, parental controls, external subtitles & styling, remote key remapping, picture-in-picture & multi-view, official store launches, and Vega / Tizen / webOS targets.

## Platforms

| Platform | Runtime | Status |
|---|---|---|
| Android phone and tablet | Expo app + Media3 | Working (verified on emulator) |
| Android TV / Google TV | Expo app (TV build) + Media3 | Working (verified on emulator) |
| Fire TV (Fire OS 7+) | Expo app (TV build) + Media3 | Working (verified on emulator) |
| iPhone and iPad (18+) | Expo app + AetherEngine | Working (verified on simulator; device compile checked) |
| Apple TV (tvOS 18+) | Expo app (TV build) + AetherEngine | Working (verified on simulator; device compile checked) |
| Windows 10/11 | Electron + react-native-web + LGPL mpv | Working (test build ready) |
| macOS | Electron + react-native-web + LGPL mpv | Working (test build ready) |
| Linux | Electron + react-native-web + LGPL mpv | Scaffolded, best effort |
| Fire TV (Vega OS) | Separate app sharing packages | Planned |
| Samsung Tizen | Web-TV app from the react-native-web bundle | Planned |
| LG webOS | Web-TV app from the same bundle | Planned |

Hardware that the project does not own is tested on emulators and simulators and marked "not verified on hardware". Once releases begin, GitHub Releases on [`fatihmutluu/elv-iptv`](https://github.com/fatihmutluu/elv-iptv/releases) and the official store listings named here will be the only authentic download sources.

## Pillars

In priority order:

1. **Stable and fast.** No crashes, no CPU or memory leaks, fast playback start and channel switching, instant UI with 100k+ items even on 1 GB TV sticks.
2. **Plays everything.** Every common container, codec and text subtitle format, live and on demand, with automatic recovery from provider hiccups.
3. **Premium streaming-app UX.** One coherent experience across TV remote, touch, mouse and keyboard.
4. **Built to be extended.** Clean pure-TypeScript architecture, strict layer boundaries, tests first for every change, and concise docs that both humans and AI coding agents can follow.

## How to help

Every kind of contribution moves the project forward:

- **Share ideas and missing workflows:** You do not need to write code to help. Opening a [feature request](https://github.com/fatihmutluu/elv-iptv/issues/new?template=feature_request.yml) about a workflow, shortcut or detail you loved in another player — or always wished existed — helps hugely (please describe the behavior itself without naming third-party apps or pasting real playlist URLs).
- **Test and report bugs:** Try builds on real TV boxes, sticks, phones and desktops and file [bug reports](https://github.com/fatihmutluu/elv-iptv/issues/new?template=bug_report.yml) (always strip playlist URLs and credentials).
- **Build features and fixes:** Browse open [issues](https://github.com/fatihmutluu/elv-iptv/issues) by priority (`priority:critical`, `priority:high`, `priority:medium`, `priority:low`), workstream cluster (`cluster:*`), or `help wanted` / `good first issue`, and read [CONTRIBUTING.md](CONTRIBUTING.md). The repository ships shared agent rules and skills (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.agents/`, `.claude/`) so contributors using AI coding tools automatically follow the project's test-first workflow.

Contributions require signing the [CLA](CLA.md) on your first pull request. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Full documentation is indexed in [docs/INDEX.md](docs/INDEX.md).

## License

ELV IPTV is open source under the [GNU General Public License v3.0](LICENSE) (`GPL-3.0-only`). Contributions come under the [CLA](CLA.md), which allows the owner to relicense the project, including a commercial or store-specific release; every version released under GPL-3.0 stays available under GPL-3.0 forever. Third-party components keep their own licenses, and shipped builds dynamically link LGPL media libraries only.

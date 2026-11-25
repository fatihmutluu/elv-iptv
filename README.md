# ELV IPTV

Cross-platform IPTV player for every screen — Android TV, Fire TV, Apple TV, Android, iPhone, iPad, macOS, Windows and Linux. Bring your own M3U or Xtream Codes playlist; no content included.

## Mission

Most IPTV viewers today face an unpleasant choice: put up with dated or half-finished interfaces, or juggle completely different players across their TV, phone and computer.

ELV IPTV provides a single fast, rock-solid, complete IPTV player across TV, mobile, and desktop — distributed exclusively through official app stores. You bring your own M3U/M3U8 playlist (URL or file) or Xtream Codes source; the app works out of the box with no account required (an optional account later will only add end-to-end encrypted cross-device sync).

## What it is not

- It ships no content, playlists, channels, provider links or provider directories, and it has no "find a provider" feature.
- It does not circumvent DRM.
- It is not a streaming service: you need your own legal playlist or subscription.

## Status and roadmap

Development is priority-driven and tracked openly on the public [roadmap](https://github.com/users/fatihmutluu/projects/1) and [issues](https://github.com/fatihmutluu/elv-iptv/issues) using `priority:*` (`critical`, `high`, `medium`, `low`), 12 `cluster:*` workstream labels, and Parent Epics — without rigid version-bucket gates. Releases are cut whenever ready.

- **Working today:** Cross-platform live TV, movies and series player across Android TV, Fire OS, Android, Apple TV, iPhone/iPad, Windows and macOS — Cinema Quietude UI/UX design system, M3U and Xtream import into on-device SQLite, instant 100k+ item navigation, sub-second warm channel switching, strict single-connection safety on 1-connection providers, stream fault recovery, live Favorites stage, VOD play/pause/seek/speed, multi-audio and subtitle track selection, and English + Turkish localization.
- **Active backlog (by priority):** XMLTV electronic program guide (EPG) grid, Home screen continue watching & favorites sync, watch progress/resume, Turkish-aware FTS5 search, in-canvas desktop video overlays, playback & codec hardening, official app store launches (Apple App Store, Mac App Store, Microsoft Store, Google Play, Amazon Appstore), optional end-to-end encrypted cross-device sync, local profiles, catch-up, live time-shift, Stalker portals, parental controls, external subtitles & styling, remote key remapping, picture-in-picture & multi-view, and Vega / Tizen / webOS targets.

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

Hardware that the project does not own is tested on emulators and simulators and marked "not verified on hardware". Official store listings on the Apple App Store, Mac App Store, Microsoft Store, Google Play, and Amazon Appstore are the only authentic download sources.

## Pillars

In priority order:

1. **Stable and fast.** No crashes, no CPU or memory leaks, fast playback start and channel switching, instant UI with 100k+ items even on 1 GB TV sticks.
2. **Plays everything.** Every common container, codec and text subtitle format, live and on demand, with automatic recovery from provider hiccups.
3. **Premium streaming-app UX.** One coherent experience across TV remote, touch, mouse and keyboard.
4. **Built to be extended.** Clean pure-TypeScript architecture, strict layer boundaries, tests first for every change, and concise docs that both humans and AI coding agents can follow.

## Feedback and bug reports

External code contributions are currently closed while ELV IPTV is proprietary (see [ADR 0016](docs/adr/0016-proprietary-store-only-distribution.md)), but product feedback and bug reports are welcome:

- **Share ideas and missing workflows:** Open a [feature request](https://github.com/fatihmutluu/elv-iptv/issues/new?template=feature_request.yml) about a workflow, shortcut or detail you would like to see (please describe the behavior itself without naming third-party apps or pasting real playlist URLs).
- **Report bugs:** File [bug reports](https://github.com/fatihmutluu/elv-iptv/issues/new?template=bug_report.yml) with your platform, OS version and reproduction steps (always strip playlist URLs and credentials).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Full documentation is indexed in [docs/INDEX.md](docs/INDEX.md).

## License

ELV IPTV is proprietary software — `Copyright (c) 2026 Fatih Mutlu. All Rights Reserved.` (see [LICENSE](LICENSE) and [ADR 0016](docs/adr/0016-proprietary-store-only-distribution.md)). Official builds are distributed exclusively through the Apple App Store, Mac App Store, Microsoft Store, Google Play, and Amazon Appstore. Third-party open-source dependencies retain their respective upstream licenses (listed offline in the in-app Third-Party Notices screen), and native media engines dynamically link LGPL libraries only. Prior versions explicitly released under GPL-3.0 remain available under that license as originally distributed; [CLA.md](CLA.md) is preserved as a historical record for prior contributions.

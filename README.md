# ELV IPTV

Fast, stable IPTV player for every screen — Android TV, Fire TV, Apple TV, Android, iPhone, iPad, macOS, Windows and Linux. Bring your own M3U or Xtream Codes playlist; no content included.

## Status

Round 0 — bootstrap. The repository holds the toolchain, empty apps and project rules. The player is not usable yet.

## What it is

A cross-platform player for live TV, movies and series from sources you bring: M3U/M3U8 playlists (URL or file) and Xtream Codes accounts. It is fully usable without an account; an account will only add cross-device sync.

## What it is not

- It ships no content, playlists, provider links or provider directories, and it has no "find a provider" feature.
- It does not circumvent DRM.
- It is not a service: you need your own playlist or subscription.

## Platforms

| Platform | Runtime | Status |
|---|---|---|
| Android phone and tablet | Expo app | Round 0 |
| Android TV / Google TV | Expo app (TV build) | Round 0 |
| Fire TV (Fire OS 7+) | Expo app (TV build) | Round 0 |
| iPhone and iPad (18+) | Expo app | Round 0 |
| Apple TV (tvOS 18+) | Expo app (TV build) | Round 0 |
| Windows 10/11 | Electron + react-native-web | Round 0 |
| macOS | Electron + react-native-web | Round 0 |
| Linux | Electron + react-native-web | Best effort |
| Fire TV (Vega OS) | Separate app sharing packages | Planned, after Android TV and Fire OS are stable |
| Samsung Tizen | Web-TV app from the react-native-web bundle | Planned, placeholder |
| LG webOS | Web-TV app from the same bundle | Planned, after Tizen |

Hardware that the project does not own is tested on emulators and simulators and marked "not verified on hardware".

## Pillars

In priority order:

1. **Stable and fast.** No crashes, no CPU or RAM leaks, fast playback start and channel switching, instant UI with 100k+ items on 1 GB TV sticks.
2. **Plays everything.** Every common container, codec and subtitle format, live and on demand.
3. **Premium streaming-app UX.** One polished experience on TV remote, touch, mouse and keyboard.
4. **Built to be extended.** Clear module boundaries, tests for every feature, lean docs that humans and AI agents can navigate.

## Pledge

ELV IPTV will stay free forever if the community supports its development. If that support doesn't come, it will have to be published as a paid app.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Contributions require signing the [CLA](CLA.md) on your first pull request. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities as described in [SECURITY.md](SECURITY.md). A map of the documentation is in [docs/INDEX.md](docs/INDEX.md).

## License

ELV IPTV is source-available under the [PolyForm Shield License 1.0.0](LICENSE). Third-party components keep their own licenses.

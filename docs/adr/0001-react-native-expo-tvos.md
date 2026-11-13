# 0001 React Native with Expo and react-native-tvos

- Status: Accepted
- Date: 2026-11-13

## Context and problem

ELV IPTV needs one TypeScript codebase for phone, tablet, Android TV, Fire OS, iOS, iPadOS and tvOS. An earlier evaluation of another framework was re-checked against the owner's weighting, where TV quality matters most.

## Decision drivers

- TV quality on Android TV, Fire TV and Apple TV.
- Maintenance by a small team and AI agents.
- A path to Vega OS and web TVs later.

## Considered options

- The framework from the earlier evaluation (superseded).
- React Native through Expo and `react-native-tvos`.
- Separate native apps per platform.

## Decision outcome

React Native through Expo SDK 58 (React 19.3), with `react-native` aliased to `react-native-tvos@0.88.x` and `@react-native-tvos/config-tv`. One app (`apps/tv-mobile`) uses an env-driven `app.config.ts` (`EXPO_TV`, `APP_VARIANT`, `STORE`) and continuous native generation, so `android/` and `ios/` are never committed. No Gradle product flavors, no Google Play Services, no EAS (prebuild, Gradle, xcodebuild, fastlane). Android `minSdkVersion` 28; iOS, iPadOS and tvOS 18.0.

### Consequences

- Good: one codebase reaches phone, tablet, Android TV, Fire OS, iOS, iPadOS and tvOS; the TV fork tracks React Native releases closely; the Expo Modules API fits native engines.
- Bad: TV focus and long lists need our own code (ADR 0004); upstream TV regressions are possible; we own the native build pipeline.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) section 4.

# 0003 Playback engines behind one PlayerEngine contract

- Status: Accepted
- Date: 2026-11-13, amended 2026-11-14, 2026-11-15, 2026-11-23

## Context and problem

Each runtime plays video differently, but features and recovery logic must be written once and tested without real players.

## Decision drivers

- Stable, fast playback on weak TV hardware.
- One contract across engines, testable with a fake engine.
- LGPL-only components in shipped builds.

## Considered options

- One engine everywhere.
- One engine per runtime behind a shared contract.

## Decision outcome

One `PlayerEngine` contract: enqueue-and-return commands, an attempt token on every event, progress as a clock anchor that JS extrapolates, stable error codes with recovery hints, capability flags per engine. Engines: Android, Android TV and Fire OS use Media3 (own FFmpeg audio extension, libass) by default with an own LGPL libmpv fallback; Apple platforms use AetherEngine; desktop uses the libmpv helper (ADR 0002). `PlaybackService` owns the state machine and a recovery ladder (L0-L5) with a separate backoff path for provider connection limits (429/509) that never opens a second connection. Video renders in native surfaces under an always-mounted JS OSD on mobile and TV. Vega, Tizen and webOS engines are chosen when those platforms are scheduled (ADR 0010).

### Amendment 2026-11-14 (player core)

- Licence: AetherEngine is LGPL-3.0 with an app-store and DRM exception that covers its own code only; the FFmpeg it
  uses stays LGPL and is linked dynamically, so the LGPL-only driver holds.
- Apple pin: AetherEngine 7.66.1. Tag 7.67.0 does not compile with the toolchain of our tvOS build job (a type-check
  timeout, deterministic on every architecture, for tvOS and iOS); 7.66.1 builds for the tvOS simulator, a tvOS device
  and the iOS simulator. A newer tag replaces the pin only after it builds with that toolchain.
- MPVKit is no longer the insurance: its own documentation says it is not maintained frequently and points to
  AetherEngine, and it must never be linked into the same app as AetherEngine (both bring FFmpeg, whose symbols
  clash). The Apple fallback is VLCKit (TVVLCKit on tvOS, LGPL-2.1).
- Media3 preloading (`DefaultPreloadManager`) is not used for live channels: it targets VOD feeds and would hold extra
  connections, which one-connection providers punish. A zap loads one media at a time.

### Amendment 2026-11-15 (Apple engine)

- Build integration: `@elv/engine-aether` (`modules/engine-aether`, tvOS, iOS and iPadOS) integrates `AetherEngine`
  `7.66.1` via React Native's CocoaPods `spm_dependency` paired with our own `[ELV] Embed AetherEngine frameworks` build
  phase (`with-aether-frameworks.ts` + `embed-frameworks.sh`), which strips headers, `lipo`-thins, inner-signs and
  copies `.dSYM`s for the nine dynamic `AetherLib*.framework` binaries without modifying `AetherEngine`.
- Forward-only live TS reader: raw live MPEG-TS (including audio-only radio channels) opens through our own
  `LiveTsReader` (`IOReader`) and `ConnectionGate` over a per-engine `URLSession`, avoiding `AVIOReader`'s 256 KiB
  initial read stall, cancelling superseded stream sockets immediately with zero provider overlap, and routing audio-only
  TS to `AetherEngine`'s libavcodec `AudioPlaybackHost`.
- Licence duties (`#98` before shipping `0.1` builds): in-app third-party notices must publish the exact `AetherEngine`
  tag (`7.66.1`), its LGPL-3.0 + app-store/DRM exception text and any modifications (none in `0.1`), keep the nine
  `AetherLib*.framework` FFmpeg/codec libraries dynamic with their LGPL notice and source link, and include `libdovi`'s
  permissive notice alongside `dav1d`/`zimg`/`zvbi`.
- Fallback rule: `VLCKit` (`TVVLCKit` / `MobileVLCKit`, LGPL-2.1) remains the unlinked Apple fallback and is never
  co-linked into the same binary as `AetherEngine`.

### Amendment 2026-11-23 (Apple engine toolchain re-check, #85)

- Re-check: tested newest upstream tag `AetherEngine 7.73.0` (`bbcf3b8359252b361258dc79817c4f81683df7b8`) on
  2026-11-23 against `Xcode 26.4.1 (17E202)` / `Apple Swift 6.3.1` (`Release`) for all three targets
  (`tvOS Simulator`, `tvOS` device, `iOS Simulator`).
- Result: all three targets fail deterministically at `Sources/AetherEngine/Diagnostics/PerFrameBenchmark.swift:374:16`
  (`error: the compiler is unable to type-check this expression in reasonable time`).
- Pin decision: Apple pin remains `7.66.1`.

### Consequences

- Good: engines are swappable; recovery is uniform; a `FakePlayerEngine` makes the service testable.
- Bad: AetherEngine is a young single-maintainer project with a fast release pace (pinned to a tag that builds, VLCKit as the fallback); own LGPL libmpv and FFmpeg builds are required; the engines need a spike before they are final.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 3, 4, 5.5, 11.
- [Player core spec](../superpowers/specs/2026-11-14-player-core-design.md) sections 4, 6.2 and 10 (engine scan, Apple build spike).

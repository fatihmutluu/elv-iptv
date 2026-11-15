# 0003 Playback engines behind one PlayerEngine contract

- Status: Accepted
- Date: 2026-11-13, amended 2026-11-14

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

### Consequences

- Good: engines are swappable; recovery is uniform; a `FakePlayerEngine` makes the service testable.
- Bad: AetherEngine is a young single-maintainer project with a fast release pace (pinned to a tag that builds, VLCKit as the fallback); own LGPL libmpv and FFmpeg builds are required; the engines need a spike before they are final.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 3, 4, 5.5, 11.
- [Player core spec](../superpowers/specs/2026-11-14-player-core-design.md) sections 4, 6.2 and 10 (engine scan, Apple build spike).

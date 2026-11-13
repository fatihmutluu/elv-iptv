# 0003 Playback engines behind one PlayerEngine contract

- Status: Accepted
- Date: 2026-11-13

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

### Consequences

- Good: engines are swappable; recovery is uniform; a `FakePlayerEngine` makes the service testable.
- Bad: AetherEngine is a young single-maintainer project (pinned, MPVKit as insurance); own LGPL libmpv and FFmpeg builds are required; the engines need a spike before they are final.

## Links

- [Foundation spec](../superpowers/specs/2026-11-13-foundation-design.md) sections 3, 4, 5.5, 11.
- Research [14](../research/14-rn-player-engines.md).

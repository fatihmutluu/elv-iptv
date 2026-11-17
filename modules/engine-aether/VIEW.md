# `AetherSurface` view (`@elv/engine-aether`)

How `AetherSurfaceView` (`ios/Engine/AetherSurfaceView.swift`) presents an engine's video on tvOS, iOS and iPadOS (player core spec 6.2). The module's contract and rules are in `AGENTS.md`.

## Surface & Subtitles
- One `AetherPlayerView`, created with the `ExpoView` and never replaced, sits beneath an unfocusable `AetherSubtitleOverlayView` (`ios/Engine/AetherSubtitleOverlayView.swift`) and black `ShutterOverlayView`. All subviews set `isUserInteractionEnabled = false`, `isAccessibilityElement = false` and `canBecomeFocused == false`, so tvOS D-pad focus and React Native overlays drawn above the surface compose cleanly over the picture.
- On `.loopback` and `.software` routes, `AetherSubtitleOverlayView` renders active `.text`, `.richText` and bitmap `.image` `SubtitleCue`s (`cue.startTime <= clock.sourceTime < cue.endTime`) inside the aspect-fit / aspect-fill video rect (`AVMakeRect` / `resizeAspectFill`); on `.remoteBypass` (HLS WebVTT), `AVPlayer` renders legible renditions natively and `subtitleCues` stays empty. Cues clear immediately on `load`, `retry`, `stop`, `recreate`, `release`, unbind, surface loss and `selectSubtitleTrack(null)`.
- `ExpoFabricView.shouldBeRecycled()` is `false` across Expo views on iOS/tvOS, so Fabric never recycles a surface view across engines; unmount clears window availability in `didMoveToWindow` and detaches the `AetherPlayerView` on deallocation.
- `clipsToBounds = true` clips `fill` (`resizeAspectFill`) crops strictly inside the view's bounds.
- Surface availability is `window != nil && !appInBackground && boundEngine != nil`. `didMoveToWindow` and `UIApplication` background/foreground notifications (`didEnterBackgroundNotification`, `willEnterForegroundNotification`, `didBecomeActiveNotification`, observed synchronously on the main thread) call `core.surfaceChanged(available:)`, emitting `surface` `created` on each rise and `surface` `destroyed` on each fall.

## Reports from the engine
- `EngineMainDriver` binds at most one `AetherSurfaceView` per `EngineObject`. Rebinding unbinds any previous view (`surface` `destroyed`) before attaching `playerView` to `AetherBackend` (`engine.bind(view:)`) and pushing `core.viewSnapshot` (`shutterCovered`, `screenOn`).
- Every shutter and screen-on update checks `boundEngine === engine`, so reports from a previous or disposed engine are ignored.

## Zap shutter
- `ShutterOverlayView` starts visible (`isHidden = false`) before any media loads and covers from each `load` (new media serial) until `AetherEngine.$hasFirstFrameReadyForDisplay` fires for that serial.
- `AetherBackend.stopMedia()` calls `engine.stop(resetDisplayCriteria: false, finalTeardown: false)` synchronously before starting the next serial, clearing `hasFirstFrameReadyForDisplay` behind the serial fence so an older channel's frame never lifts the new channel's shutter. Audio-only streams keep the black shutter covered. `retry`, `stop` and `recreate` keep the current shutter state.

## Picture shape (`resizeMode`)
- `resizeMode="fit"` (default) sets `AetherEngine.videoGravity = .resizeAspect` (full picture with black bars inside `AetherSurfaceView`'s black background); `resizeMode="fill"` sets `.resizeAspectFill` (cropped to `bounds` via `clipsToBounds`).
- `AetherBackend` reapplies `videoGravity` whenever the surface binds or `rebuild()` swaps in a fresh `AetherEngine`.

## Screen on (`IdleTimer`)
- `EngineCore` enables keep-screen-on at `playing` and at `buffering` once the current serial has played, and clears it at `paused`, `ended`, error, `stop`, `release` and surface loss (`opening` and `ready` keep the previous state across zaps and retries).
- `IdleTimer` maintains a process-wide set of active engine owners holding the screen awake while their bound surface is in a foreground window, driving `UIApplication.shared.isIdleTimerDisabled`.

## Background and foreground
- `AetherEngine.backgroundPlaybackEnabled` is `false` in 0.1 (no PiP or background audio). Entering the background synchronously marks the surface unavailable: `EngineCore` emits `surface` `destroyed`, stops the media (`stopMedia()`), clears `IdleTimer`, and emits `error` `surface-lost`, parking `@elv/playback` in `awaitingSurface` without spending recovery rungs or holding a provider connection.
- Returning to the foreground (`willEnterForegroundNotification` / `didBecomeActiveNotification`) emits `surface` `created`, triggering `@elv/playback` rung 1 (`retry`) to reload the live edge or last anchored VOD position automatically (verified on `Apple TV 4K (3rd generation)` tvOS 26.4 simulator across a 5 s switch to `com.apple.TVSettings` and back: `Channel 1002` resumed `playing` within 4 s with advancing frames and OSD clock `6:46` -> `6:49` across a 3 s interval).

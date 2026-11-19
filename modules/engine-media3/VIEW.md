# `Media3Surface` view (`@elv/engine-media3`)

How `Media3SurfaceView` (`android/.../Media3SurfaceView.kt`) and `SurfaceController` (`android/.../SurfaceController.kt`)
present an engine's video and subtitles (player core spec 6.1). The module's contract and rules are in `AGENTS.md`.

## Surface, shutter and subtitles
- One `SurfaceView`, created with the view and never re-typed, replaced or put on top (`setZOrderOnTop` and
  `setZOrderMediaOverlay` are never called), covered by a black zap shutter `View`, with `SubtitleView`
  (`androidx.media3:media3-ui`) laid out above the shutter over the same fitted `VideoRect` (`placed`) for native text
  (`SRT`, `ASS`, `WebVTT`, `TTML`) and bitmap (`DVB`, `PGS`) cues. Placing `SubtitleView` above the shutter keeps cues
  visible on audio-only streams while the shutter stays closed over `SurfaceView`; cues clear immediately on every
  prepare (`load`, `retry`, HLS handoff), `stop`, `recreate`, `bind` and `selectSubtitleTrack(..., null)`.
- None of the child views is focusable. Only valid (`Surface.isValid`) surfaces are attached to `ExoPlayer`.
- The view paints black bars beside the surface only, never over it, so React Native views drawn above compose over
  video and subtitles. `dispatchDraw` clips to the view, keeping a `fill` crop inside it.
- Surface callbacks attach (posted to the playback thread) and detach the surface; the engine sends `surface`
  `created` once per attach and `destroyed` for an attached surface. A detach (`surfaceDestroyed`, an engine swap on
  one view) is the only UI-thread wait: it runs ahead of queued commands (inline on the playback thread) and is capped
  at 3 s (Media3's 500 ms release timeout plus its 2 s detach timeout, with margin).

## Reports from the engine (`SurfaceController`)
- `SurfaceController` posts every report to the bound view's `ViewSink` on the playback thread (logging a warning if a
  second view replaces an active binding); the view applies it on the UI thread only while that binding is current, so a
  previous engine's queued reports are ignored.
- Binding resets `placed` and sends the current shutter, gated picture size (`awaitingVideoSize` blocks a previous
  channel's `VideoSize` from leaking across zaps before the new media decodes video), screen-on state and cues.

## Zap shutter (`ZapShutter`, `PrepareFence`)
- Covers before any media and from each `load` (a new media serial) until that video media's first frame; reports of
  older serials change nothing, and a media that showed its frame stays uncovered. Audio-only streams emit `firstFrame`
  on initial `playing` while keeping the shutter closed over `SurfaceView`. Not re-covered on `retry`, `stop`,
  `recreate`.
- `PrepareFence` sends a `PlayerMessage` behind `stop` through Media3's internal playback thread so late first-frame,
  video-size, cue and reused-player callbacks from a stopped media are discarded before reaching the view or JS.

## Picture shape (`SurfaceFit`, `fitRect`)
- The surface is sized and centred at the display aspect ratio: Media3's decoded `VideoSize` width times its sanitized
  `pixelWidthHeightRatio` (non-finite or non-positive values default to `1f`), over its height. `resizeMode` `fit`
  (default) shows the whole picture with bars; `fill` covers the view and crops the overflow. Within 1 % of the view's
  aspect the surface fills the view (no hairline bars).
- A zero size keeps the last shape on an already-bound view, so a zap resizes the surface only when the new media
  reports its own, under the shutter. An unknown shape fills the view.
- The surface and subtitle layer are measured and laid out directly when the shape or mode changes (React Native runs no
  layout pass for a native child); size changes call `surfaceChanged` only, so the surface is never recreated.

## Screen on (`keepsScreenOn`)
- Decided on the playback thread from every `state` event, error and `stop`; the view sets `keepScreenOn` while it is
  in a window. On at `playing`, and at `buffering` once the current prepare played. Off at `paused` (including transient
  audio-focus suppression), `ended`, an error (also a failed command) and `stop`, and while unbound.
- `opening`, `ready` and buffering before the first play keep the last choice, so a zap or a recovery retry from a
  playing media never lets the screen sleep.

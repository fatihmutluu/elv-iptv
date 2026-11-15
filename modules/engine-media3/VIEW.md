# `Media3Surface` view (`@elv/engine-media3`)

How `Media3SurfaceView` (`android/.../Media3SurfaceView.kt`) shows an engine's video (player core spec 6.1). The
module's contract and rules are in `AGENTS.md`.

## Surface
- One `SurfaceView`, created with the view and never re-typed, replaced or put on top (`setZOrderOnTop` and
  `setZOrderMediaOverlay` are never called), under a black shutter `View`. Neither child is focusable.
- The view paints black bars beside the surface only, never over it, so React Native views drawn above compose over
  the video. `dispatchDraw` clips to the view, which keeps a `fill` crop inside it.
- Surface callbacks attach (posted to the playback thread) and detach the surface; the engine sends `surface`
  `created` once per attach and `destroyed` for an attached surface. A detach (`surfaceDestroyed`, an engine swap on
  one view) is the only UI-thread wait: it runs ahead of queued commands (inline on the playback thread) and is capped
  at 3 s (Media3's 500 ms release timeout plus its 2 s detach timeout, with margin).

## Reports from the engine
- The engine posts every report to the bound view's `ViewSink` on the playback thread; the view applies it on the UI
  thread only while that binding is current, so a previous engine's queued reports are ignored. Binding sends the
  current shutter, picture size and screen-on state first.

## Zap shutter (`ZapShutter`, `FirstFrameFence`)
- Covers before any media and from each `load` (a new media serial) until that media's first frame; reports of older
  serials change nothing, and a media that showed its frame stays uncovered. Not shown on `retry`, `stop`, `recreate`.
- `firstFrame` is sent once per prepare, after a player message sent behind its `stop` reached the application
  thread, so a stopped media's late first-frame callback never lifts the shutter or counts as the new frame.

## Picture shape (`SurfaceFit`, `fitRect`)
- The surface is sized and centred at the display aspect ratio: Media3's decoded `VideoSize` width times its
  `pixelWidthHeightRatio`, over its height. `resizeMode` `fit` (default) shows the whole picture with bars; `fill`
  covers the view and crops the overflow. Within 1 % of the view's aspect the surface fills the view (no hairline bars).
- A zero size (Media3 reports one when a stopped media's renderer is disabled) keeps the last shape, so a zap resizes
  the surface only when the new media reports its own, under the shutter. An unknown shape fills the view.
- The surface is measured and laid out directly when the shape or mode changes (React Native runs no layout pass for
  a native child); size changes call `surfaceChanged` only, so the surface is never recreated.

## Screen on (`keepsScreenOn`)
- Decided on the playback thread from every `state` event, error and `stop`; the view sets `keepScreenOn` while it is
  in a window. On at `playing`, and at `buffering` once the current prepare played. Off at `paused`, `ended`, an
  error (also a failed command) and `stop` (the service stops on `failed` and `limited`), and while unbound.
- `opening`, `ready` and buffering before the first play keep the last choice, so a zap or a recovery retry from a
  playing media never lets the screen sleep.

# Wave C5A Design Spec — Desktop Playback & Audio/Video Pipeline (`#332`, `#205`, `#243`)

## Scope
Implements the deterministic desktop `mpv` & window-geometry batch of Wave C5 (and closes the final remaining sub-issue `#332` of Parent Epic `#333`):
1. **`#332` — Optional HiDPI-Rounded Windowed Aspect-Ratio Lock:** Snap windowed (non-maximized, non-fullscreen) desktop content bounds to the active video's display aspect ratio (DAR) on the `devicePixelRatio` physical pixel grid (`100%`, `125%`, `150%`, `200%` scaling) with zero 1 px letterboxing/cropping bars.
2. **`#243` — Desktop `mpv` Broadcast Deinterlacing (`off`/`auto`/`bwdif`), `scaletempo2` (`pitchLock`), and `loudnorm` Audio Normalization:** Persist `deinterlaceMode`, `pitchLock`, and `audioNormalization` preferences in `@elv/domain`, wire labeled `vf`/`af` filters (`@elv_deint`, `@elv_loudnorm`) and `audio-pitch-correction` cleanly without clobbering existing filters or breaking S/PDIF bitstream passthrough.
3. **`#205` — Gapless Series Auto-Advance via `mpv` `append-play`:** Queue the next resolved series episode (including across season boundaries) via `loadfile <url> append-play` with `--prefetch-playlist=no` single-connection safety, custom-header match guarding, and seamless `queueAdvanced` handoff back to `PlaybackService` and `usePlayerTargetHandoff`.

## Architecture

### 1. Domain & i18n (`@elv/domain`, `@elv/i18n`)
- **`@elv/domain` (`preferences-validators.ts`, `preferences.ts`):**
  - `DeinterlaceMode = 'off' | 'auto' | 'bwdif'` -> `deinterlaceMode: DeinterlaceMode` (default `'off'`).
  - `pitchLock: boolean` (default `true` — shared with Android Media3 `#264`).
  - `audioNormalization: boolean` (default `false`).
  - `windowAspectRatioLock: boolean` (default `false`).
- **`@elv/i18n`:** EN + TR parity in `.po` & `src/locales/{en,tr}.ts` for deinterlace mode (`Off` / `Auto` / `Broadcast (bwdif)`), pitch lock, loudness normalization, and desktop windowed aspect-ratio lock.

### 2. HiDPI-Rounded Windowed Aspect-Ratio Lock (`#332`, `apps/desktop`)
- **`apps/desktop/src/main/player/mpv/video-info.ts`:** Extract DAR from `video-params` (`aspect`, or `dw / dh`, or fallback `width / height`) and expose `aspectRatio?: number` on `MediaInfo` / `StreamVideoInfo`.
- **`apps/desktop/src/main/player/presenter/bounds.ts`:** Pure `lockContentRectToAspect(contentRect, aspectRatio, scaleFactor, minContentSize, changedEdge?)` snapping content width/height cleanly to `1 / scaleFactor` physical pixels (avoiding 1 px bars at `1.0`, `1.25`, `1.5`, `2.0` DPR while honoring minimum content size).
- **`apps/desktop/src/main/window-bounds.ts` / `window-ipc.ts` / `main.ts`:**
  - Expose typed `setAspectRatioLock(enabled: boolean)` IPC on window bridge.
  - Intercept `will-resize` on the `BrowserWindow` only when `aspectRatioLock === true`, `!isMaximized()`, `!isFullScreen()`, `gateQuery === null`, and active playback video DAR `> 0`.
  - Compute chrome deltas (`outer - content`), lock target content rect via `lockContentRectToAspect`, re-add chrome deltas, and call `setBounds` / prevent default cleanly so `own-window` & `canvas` stay bar-free.

### 3. Desktop `mpv` Deinterlace, `scaletempo2`, `loudnorm` (`#243`, `apps/desktop`)
- **`apps/desktop/src/main/player/mpv/options.ts`:**
  - Launch with `--prefetch-playlist=no` (also guarantees `#205` single-connection safety) and `--audio-pitch-correction=yes` default.
  - Keep `deinterlace` and `vf` cleanly managed via labeled filters.
- **`apps/desktop/src/main/player/engine-controls.ts`, `engine.ts`, `mpv/live-session.ts`, `ipc.ts`, `shared/player-ipc.ts`, `renderer/src/player/desktop-engine.ts`:**
  - `setDeinterlaceMode('off' | 'auto' | 'bwdif')`:
    - `'off'`: `['set_property', 'deinterlace', 'no']` + `['vf', 'remove', '@elv_deint']`
    - `'auto'`: `['set_property', 'deinterlace', 'auto']` + `['vf', 'remove', '@elv_deint']`
    - `'bwdif'`: `['set_property', 'deinterlace', 'no']` + `['vf', 'add', '@elv_deint:lavfi=[bwdif=mode=send_frame:parity=auto:deint=interlaced]']`
    - Keep `setDeinterlace(boolean)` delegating cleanly to `'auto' | 'off'` for backwards compatibility.
  - `setPitchLock(boolean)`: `['set_property', 'audio-pitch-correction', locked ? 'yes' : 'no']` (enables `mpv`'s `scaletempo2` automatically whenever `speed != 1.0`).
  - `setAudioNormalization(boolean)`: labeled `['af', 'add', '@elv_loudnorm:lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11]']` / `['af', 'remove', '@elv_loudnorm']` — never clobbers `@ac3:lavcac3enc` or other filters; automatically suppressed while S/PDIF/HDMI bitstream passthrough is active!
  - Persist all 3 states on engine controls and re-apply across spawn, `load()`, and `recreate()`.

### 4. Gapless Series Auto-Advance via `mpv` `append-play` (`#205`)
- **Security & ConnectionGate invariants:**
  - Next-episode URLs are resolved lazily right before queueing, sent only over local mpv IPC, and redacted from all logs (`redactUrls()`).
  - `--prefetch-playlist=no` guarantees zero overlapping TCP sockets on `maxConnections === 1` providers!
  - Only queue via `append-play` when `kind === 'vod'`, `autoPlayNextEpisode === true`, and custom HTTP headers match the active episode (since `http-header-fields` is per-process in `mpv`).
- **`apps/desktop/src/main/player/`:**
  - `mpv/options.ts`: `loadfileCommand(..., mode: 'replace' | 'append-play' = 'replace')`.
  - `mpv/session-constants.ts`: observe `'playlist-pos'` & `'playlist-count'`.
  - `mpv/entries.ts` & `mpv/live-session.ts` & `engine.ts`: track optional `queuedSlot` (`{ itemKey, attempt, entryId, request }`) alongside `media`.
    - `queueNext(request)` sends `loadfile <url> append-play -1 <opts>` (after clearing any prior queued entry via `playlist-clear` if replacing a previous queued target) and records `queuedSlot.entryId`.
    - When `onEndFile` receives `reason === 'eof'` while `queuedSlot` is queued, suppress premature `'ended'`; when `onStartFile` fires for `queuedSlot.entryId`, promote `media = queuedSlot`, clear `queuedSlot`, reset deriver state cleanly for the new attempt/entry, and emit `{ type: 'queueAdvanced', itemKey, attempt }`!
    - Any manual `load()`, `stop()`, `recreate()`, or `clearQueue()` issues `['playlist-clear']` and drops `queuedSlot`.
- **`packages/features/src/ports/video-host.ts` & `packages/features/src/player/`:**
  - Expose optional `setDeinterlaceMode`, `setPitchLock`, `setAudioNormalization`, `queueNext`, `clearQueue`, and `onQueueAdvanced` on `OpenVideoEngine`.
  - In `usePlayerTargetHandoff.ts` / `usePlayerSession.ts`: when watching a series episode with `autoPlayNextEpisode` enabled and `nextEpisode` resolved (including across season boundaries), lazily resolve and queue it on desktop; when `onQueueAdvanced` fires, update `activeTarget`, `WatchProgressSync`, `NextEpisodeBanner`, and `MediaSessionMetadata` seamlessly!
  - Expose settings controls in `PlaybackSettingsPanel.tsx` & `PlayerSettingsSheet.tsx` (100% TV D-pad & desktop reachable).

## Verification
- Pure packages maintain `>= 90%` line coverage; `apps/desktop` covers HiDPI aspect rounding (`100%/125%/150%/200%`), labeled `vf`/`af`/`scaletempo2` filters + passthrough guard, and `FakeMpv` `append-play` gapless transition + cross-season advance + `playlist-clear` on zap/stop.
- `pnpm check` passes `11 passed, 0 failed`, independent review `VERDICT: PASS`, green CI, squash-merge -> **CLOSE Parent Epic `#333`**!

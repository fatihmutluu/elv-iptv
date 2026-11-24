# Wave F0B — Live Audio/Subtitle Delay & Adaptive Video Resolution Selector (`#59`, `#203`, `#239`)

- **Date:** 2026-11-24
- **Issues:** `#59`, `#203`, `#239`
- **Design philosophy:** Cinema Quietude v2 (`docs/design/UI_UX_PHILOSOPHY.md`) — zero hardcoded hex, zero RN `<Modal>` on TV, 100% EN/TR Lingui parity, zero session teardown on delay or ABR cap adjustments, per-channel/series persistence via existing `#208` `track_preferences`.

## 1. Shared Playback Contract (`packages/playback/`)
- `VideoQualityOption`: `{ id: string; label: string; width?: number; height?: number; bitrateBps?: number; fps?: number }`.
- `MediaTracks`: adds optional `videoQualities?: readonly VideoQualityOption[]`, `selectedVideoQualityId?: string | null` (`null` = Auto ABR), and `selectedSecondarySubtitleId?: string | null`.
- `EngineCapabilities`: adds optional `audioDelay?: boolean`, `subtitleDelay?: boolean`, `videoQualitySelection?: boolean`.
- `PlayerEngine` & `NativeEngineHandle` (`native-bridge.ts`): adds optional `setAudioDelay?(attempt, delayMs)`, `setSubtitleDelay?(attempt, delayMs)`, `selectVideoQuality?(attempt, id: string | null)`, `selectSecondarySubtitleTrack?(attempt, id: string | null)`.
- `PlaybackService`: exposes `setAudioDelay(delayMs)`, `setSubtitleDelay(delayMs)`, `selectVideoQuality(id: string | null)`, `selectSecondarySubtitleTrack(id: string | null)` clamping delays to `[-30_000, 30_000]` ms and resetting transient state cleanly on `tune`/`stop`.

## 2. `#203` & `#59` — Android Media3 (`modules/engine-media3/`)
- **`TimedSubtitleCueBuffer.kt`:** Bounded queue (`<= 128`) storing emitted `CueGroup`s with presentation timestamp `positionUs` and resolving active cues at `playerPositionUs - subtitleDelayUs` so changing `subtitleDelayMs` mid-playback shifts subtitle timing immediately WITHOUT flushing currently buffered cues!
- **`OffsetForwardingAudioSink.kt` (`PolicyVideoRenderer.kt` `buildAudioSink`):** Wraps `DefaultAudioSink` in `ForwardingAudioSink`, offsetting `getCurrentPositionUs(sourceEnded)` by `audioDelayUs` (clamped `>= 0`, preserving `AudioSink.CURRENT_POSITION_NOT_SET`) with zero buffer reallocation!
- **Adaptive video resolution (`TrackSelectorBridge.kt`):** Extracts deduplicated selectable video renditions (`videoQualities`) from Media3 `Tracks` (sorted descending by height/bitrate), reports `selectedVideoQualityId` (`null` = Auto), and applies `selectVideoQuality(id)` via `DefaultTrackSelector.Parameters` (`setMaxVideoSize` / `setMaxVideoBitrate` / `TrackSelectionOverride`, clearing caps on `null` Auto) without tearing down playback.
- Exposes `setAudioDelay`, `setSubtitleDelay`, `selectVideoQuality` on `ElvEngineMedia3Module.kt` and `modules/engine-media3/src/index.ts`.

## 3. `#239` & `#59` — Desktop `mpv` (`apps/desktop/`)
- `session-constants.ts`: observe `'sub-delay'`, `'audio-delay'`, `'secondary-sid'` in `OBSERVED_PROPERTIES`; add `'secondary-sid'` to `TRACK_PROPERTIES`.
- `options.ts`: include `secondary-sid` in `--reset-on-next-file` alongside `audio-delay,sub-delay` so sync/secondary subtitle state never leaks across zaps.
- `tracks.ts` & `track-snapshot.ts`: reconcile `secondary-sid` (preventing `primary === secondary`), expose selectable video variants (`type === 'video'` when `> 1` variants exist) as `videoQualities` + `selectedVideoQualityId`.
- `player-ipc.ts`, `ipc.ts`, `engine.ts`, `engine-controls.ts`, `desktop-engine.ts`: bridge `setAudioDelay(ms)`, `setSubtitleDelay(ms)`, `selectVideoQuality(id | null)` (`vid` / `'auto'`), and `selectSecondarySubtitleTrack(id | null)` (`secondary-sid` / `'no'`) end-to-end.

## 4. `#59` — Apple `AetherEngine` (`modules/engine-aether/`)
- `EngineCore.swift`, `AetherBackend.swift`, `AetherBackend+Tracks.swift`, `EngineObject.swift`, `ElvEngineAetherModule.swift`, `src/index.ts`:
  - `setAudioDelay(attempt, delayMs)` -> `engine?.setAudioDelay(clampedMs / 1000.0)` (clamped `[-30_000, 30_000]` ms, reset to `0` on `stopMedia`).
  - `setSubtitleDelay(attempt, delayMs)` -> `engine?.setSoftwareSubtitleDelay(clampedMs / 1000.0)` + time offset in `renderSubtitles` (reset to `0` on `stopMedia`).
  - `selectVideoQuality(attempt, id)` -> applies `AVPlayerItem.preferredMaximumResolution` / `preferredPeakBitRate` (`null` restores `CGSize.zero` / `0` Auto ABR) and reports adaptive quality presets when HLS/multi-rendition playback is active.

## 5. `#59` — Player Quick Settings UI & Persistence (`packages/i18n/`, `packages/features/src/player/`)
- Adds EN/TR Lingui keys (`player.audioDelay`, `player.subtitleDelay`, `player.videoQuality`, `player.videoQualityAuto`, `player.delayReset`).
- Adds `Audio delay` (`-250/-50/0/+50/+250 ms` stepper), `Subtitle delay` (`-250/-50/0/+50/+250 ms` stepper), and `Video quality` (`Auto` + renditions when available) rows/sub-views in `PlayerSettingsSheet.tsx` & `settings-menu-nav.ts`.
- Automatically applies saved `audioDelayMs` / `subDelayMs` from `#208`'s `track_preferences` on tune and persists changes back to SQLite per channel/series!

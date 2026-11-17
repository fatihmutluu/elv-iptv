# VOD Playback Controls and Multi-Platform Audio & Subtitle Track Selection — Design

- Status: approved (owner delegated all development decisions until `0.1` ships)
- Date: 2026-11-15
- Issue: #73 (VOD playback controls: pause, seek, audio and subtitle tracks; also audio & subtitle selection on Live channels).
- Builds on: Foundation Spec (`2026-11-13-foundation-design.md` §5.5, §5.6), Player Core Spec (`2026-11-14-player-core-design.md`), Desktop Player Spec (`2026-11-14-desktop-player-design.md`), Engine Aether Spec (`2026-11-15-engine-aether-design.md`), Plain Menu Spec (`2026-11-15-plain-menu-design.md`).

## 1. Why

Version `0.1` must play movies, series episodes, and multi-track live streams completely: pausing and resuming, stepping and holding Left/Right to seek VOD accurately, choosing audio tracks (e.g., Turkish dubbing vs original audio), turning embedded subtitles on, switching language, or turning subtitles off, rendering embedded text (`SRT`, `ASS`/`SSA`, `WebVTT`) and bitmap (`DVB`, `PGS`) subtitles natively, and preserving both playback position and track choices across recovery reloads.

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- Extend `@elv/playback` (`PlayerEngine` + `PlaybackService`):
  - `MediaTracks` (`audio`, `subtitles`, `selectedAudioId`, `selectedSubtitleId`), `EngineEvent` `{ type: 'tracks', tracks }`, `LoadOptions` (`audioTrackId`, `subtitleTrackId`), and `selectAudioTrack` / `selectSubtitleTrack` (`null` = Off).
  - Fix the two VOD recovery gaps flagged in `#73`: (1) a VOD user seek disarms **both** the stall watchdog and any active VOD reconnect loop (`stepTimer`, `rungTimer`, `budget.vodStart`); (2) a VOD `retry()` after `failed` or `recreate` resumes from the last known position rather than `0:00` (while `ended` still replays from `0:00`).
  - Preserve user-selected audio and subtitle tracks across recovery reloads (`rung 2`, `rung 3`, `rung 4`, `reconnectVod`, `limited`, and `retry()`).
- Implement native track enumeration, in-place switching, and embedded subtitle rendering in all three engines:
  - **Android (`@elv/engine-media3`):** `Tracks` inspection + `TrackSelectionParameters` overrides (`C.TRACK_TYPE_AUDIO`, `C.TRACK_TYPE_TEXT` + `setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)` for Off) + `androidx.media3:media3-ui` `SubtitleView` positioned inside `Media3SurfaceView` over `placed` (`VideoRect`) under `shutterView` (renders text SRT/ASS/WebVTT and bitmap DVB/PGS cues natively).
  - **Apple (`@elv/engine-aether`):** `AetherEngine` audio & subtitle track observation + `selectAudioTrack` / `selectSubtitleTrack` (including Off) with native subtitle rendering inside `AetherPlayerView`.
  - **Desktop (`apps/desktop` `mpv`):** observe `track-list`, `aid`, and `sid` over JSON IPC; switch via `set_property` `aid` / `sid` (`'no'` for Off) and pass initial `aid`/`sid` options on recovery reloads.
- Wire plain cross-form-factor controls in `PlayerScreen` (`@elv/features`):
  - **VOD:** `OK` / `Space` toggles pause/resume; `Left` / `Right` step `-10 s` / `+10 s` on press and `-30 s` / `+30 s` on held key repeats (`repeat` events from `KeyInterpreter` / keyboard repeat), clamped to `[0, durationMs]`; plain `Play/Pause`, `-10s`, `+10s`, and clickable/touchable progress bar on phone/tablet/desktop.
  - **Live & VOD:** plain `Audio` and `Subtitles` (`Off` + tracks) selector modal/sheet inside `PlayerScreen` with full TV D-pad focus and `Back` dismissal, localized in English (`en`) and Turkish (`tr`).

### Non-Goals
- External `.srt` / `.ass` file side-loading or custom subtitle font/color styling (Round 3).
- Live stream time-shift seeking (Round 3).
- Custom themed transport chrome or thumbnail scrub previews (Round 2+).

### Anti-Goals
- Never restart VOD from `0:00` when switching audio or subtitle tracks.
- Never drive progress bars from `useState` ticks on every frame; extrapolate from `ClockAnchor` inside leaf components (`OsdClock` / `VodProgressBar`).

## 3. Detailed Design

### 3.1 `@elv/playback` Contract & Recovery Semantics
- `MediaTracks`:
  - `TrackInfo`: `{ id: string; language?: string; label?: string; codec?: string; channels?: number; forced?: boolean; isDefault?: boolean }`.
  - `EMPTY_TRACKS`: frozen `{ audio: [], subtitles: [], selectedAudioId: null, selectedSubtitleId: null }`.
- `PlaybackService`:
  - Stores `preferredAudioId: string | undefined` and `preferredSubtitleId: string | null | undefined` (`undefined` = engine default; `null` = subtitles explicitly Off; `string` = track ID). Reset only on `tune()` and `stop()`.
  - Passes `audioTrackId` and `subtitleTrackId` in `LoadCommand.options` on every reload (`sendLoad`) and re-applies `selectAudioTrack` / `selectSubtitleTrack` once if a reloaded `tracks` event reports a different selection while the preferred track ID is present in `tracks`.
  - `seek(positionMs)`: allowed when `loaded` or when `current?.kind === 'vod' && state.status.kind === 'recovering'`. Updates `state.anchor` immediately to `{ positionMs: clamped, atMs: clock.now(), rate: state.status.kind === 'playing' ? 1 : 0, ...duration }`. In `recovery.ts`, `onSeek(clamped)` sets `seekDisarmed = true`, clears `stallTimer`, updates `resumeMs = clamped`, and if a VOD reconnect loop is in progress (`budget.vodStart !== undefined` or `status.kind === 'recovering'`), cancels pending backoff timers, resets `budget`, transitions to `'tuning'`, arms `startTimeout`, and reloads at `clamped`.
  - `retry()`: if `state.status.kind !== 'ended'` and `current.kind === 'vod'` and `!loaded`, passes `startMs: lastVodPositionMs ?? current.startMs` into `startTune` while keeping `preferredAudioId` / `preferredSubtitleId`.

### 3.2 Native Engines
- **`@elv/engine-media3`:**
  - Capabilities updated to `audioTrackSelection: true`, `subtitleTrackSelection: true`.
  - Stable track IDs: `${groupIndex}:${trackIndex}` within the current media's `Tracks.groups` of `C.TRACK_TYPE_AUDIO` and `C.TRACK_TYPE_TEXT` (plus matching by language+label fallback if `LoadOptions` carries a track choice across a recovery reload!).
  - `SubtitleView` added to `Media3SurfaceView` between `surfaceView` and `shutterView`, laid out to `placed` (`VideoRect`) and fed via `Player.Listener.onCues(CueGroup)` posted to the UI thread (`ViewSink.onCues(CueGroup.EMPTY_TIME_ZERO.cues)` on load/stop/unbind so stale subtitle cues never linger across zaps!).
- **`@elv/engine-aether`:**
  - Capabilities updated to `audioTrackSelection: true`, `subtitleTrackSelection: true`.
  - Observes `AetherEngine` track lists and active selections, emits `{ type: 'tracks', tracks }`, applies `selectAudioTrack` / `selectSubtitleTrack` (`nil` disables subtitles), and reapplies `LoadOptions` track selections once `.ready` arrives.
- **Desktop `mpv` (`apps/desktop`):**
  - Capabilities updated to `audioTrackSelection: true`, `subtitleTrackSelection: true`.
  - Observes `track-list`, `aid`, and `sid`; maps `type === 'audio'` (`id` -> `"a:<id>"`) and `type === 'sub'` (`id` -> `"s:<id>"`); `selectAudioTrack` sends `['set_property', 'aid', numericId]`, `selectSubtitleTrack(null)` sends `['set_property', 'sid', 'no']`, and recovery reloads re-apply saved preferences on `file-loaded`.

### 3.3 `PlayerScreen` Controls (`@elv/features`)
- VOD remote & keyboard controls:
  - `select` (`OK` / `Space` when track picker is closed and not in `failed` state): toggles `service.pause()` / `service.play()`.
  - `left` / `right`: steps `-10_000 ms` / `+10_000 ms` on `press`, and `-30_000 ms` / `+30_000 ms` on `repeat` (held remote arrow or keyboard key repeat), clamped to `[0, durationMs]`.
- Track Picker (`player-tracks-button` -> `player-tracks-panel`):
  - Accessible on both `live` and `vod` via OSD `Audio / Subtitles` button (on TV: pressing `down` on VOD focuses transport/tracks bar; on `live`, `left` or `menu` / OSD button opens the track picker without colliding with `up`/`down` channel zapping).
  - Lists all audio tracks and `[Subtitles Off, ...subtitleTracks]` with localized language labels (`tr` -> `Türkçe` / `Turkish`, `en` -> `İngilizce` / `English`, plus track title/codec disambiguation when a language has multiple tracks).

## 4. Testing Strategy
- `@elv/playback` (Vitest `>= 90%` coverage): unit tests for `tracks` state, `selectAudioTrack`, `selectSubtitleTrack(null)`, track survival across rung 2/3/4 & `reconnectVod` & `retry()`, VOD `seek()` disarming both `stallTimer` AND `reconnectVod`, and VOD `retry()` after `recreate` / `failed` resuming from last position.
- `@elv/engine-media3` (Robolectric + Android instrumentation), `@elv/engine-aether` (SwiftPM + iOS/tvOS simulator), and `apps/desktop` (Vitest + Playwright E2E against `corpus` `h264-2audio-subs-720p25`): verify live & VOD multi-audio switching without restart, turning subtitles on (`tur` -> `eng`) and off (`null`), and pause/resume/seek accuracy.
- `@elv/features` (Jest RNTL): VOD pause/resume, step + held-repeat seek, track picker selection on TV/phone/tablet/desktop, and EN/TR localization parity.

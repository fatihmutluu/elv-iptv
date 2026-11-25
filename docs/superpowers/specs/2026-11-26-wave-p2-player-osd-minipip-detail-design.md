# Wave P2 — Player OSD Polish, Context-Aware Overflow Menu, Jump-to-Live Overhaul, Resizable Corner-Snapping Mini-Player & Detail/Language Memory

**Date:** 2026-11-26  
**Branch:** `feat/wave-p2-player-osd-minipip-detail`  
**Status:** Design Approved (Autonomous Maintainer Flow)

## 1. Goals & Scope
1. **Aspect Ratio / Resize Mode OSD Fade-Out Badge:** Cycling resize mode (`fit` / `fill` / `stretch`) displays a crisp Cinema Quietude v2 dark-glass mode pill on screen with localized name (`Sığdır` / `Doldur` / `Uzat` — `Fit` / `Fill` / `Stretch`) that holds briefly (`~1.1 s`) and smoothly fades out (`400 ms`, instant dismiss when `reduceMotion` is on).
2. **Context-Aware `⋮` Overflow Menu with Hover Tint & Description Tooltips:**
   - Every row in `PlayerSettingsSheet` gets a subtle pointer hover tint animation (`150 ms` transition, theme tokens only) and a `<Tooltip placement="left">` showing a concise description of the option.
   - Strict **Live vs VOD** separation: hide `pitchLock`, `timeDisplayMode`, and Sleep Timer's `"Pause"` action on Live TV; keep VOD-only controls strictly on VOD and Live-only controls strictly on Live.
3. **Jump-to-Live ("Canlı Uca Atla") Overhaul:**
   - Eliminate false-positive visibility triggered by normal demuxer read-ahead buffering (`4–8 s`) by requiring genuine live-edge lag (`>= 12 s` behind edge or explicit pause/backward-seek behind edge on timeshift-capable live streams).
   - Fix single-click reliability: unpause cleanly in the same interaction, use mpv's true live-edge seek (`['seek', 100, 'absolute-percent']` + unpause) instead of stale snapshot timestamps that snap behind to an older keyframe, and surface an immediate **syncing/loading spinner state** on `JumpToLiveButton` until live-edge catch-up completes.
4. **Resizable & Draggable Corner-Snapping In-App Mini-Player:**
   - Users can drag/throw the floating in-app mini-player anywhere and it smoothly snaps to the nearest of the 4 viewport corners with consistent margin padding (`16px` + safe area + overscan + portrait tab-bar clearance).
   - Add an intuitive `16:9` corner resize grip handle clamped to `[240px, min(640px, 55% viewportWidth)]` with hover tooltip.
5. **Detail Screen Version Dropdown & Sticky Global Audio/Subtitle Language Memory:**
   - Replace click-to-cycle version button on Movie/Series Detail with a clean Cinema Quietude **Version Dropdown** (`detail-preplay-version-trigger` + popover list).
   - Remove Audio & Subtitle pre-play buttons from Detail screen.
   - When the user picks an Audio or Subtitle track inside `PlayerScreen`, persist their chosen language into global preferences (`preferredAudioLang`/`preferredAudioLanguages`, `preferredSubtitleLang`/`preferredSubtitleLanguages`, smart `subtitleMode` / `preferDefaultAudioTrack`) alongside per-item/per-series memory so subsequent unrelated movies and series automatically inherit their choice.

# Wave P7 Design Spec — Settings Overhaul, Kids Mode, "Who's Watching?" 9 Avatars & Clean Sources

**Date:** 2026-11-27
**Issues:** Closes `#505`, `#506`
**Branch:** `feat/wave-p7-settings-kids-profiles`

## Summary
Streamlines Settings across desktop, mobile, tablet, and 10-foot TV, introduces a unified `SettingsDropdownRow` (inline glass dropdown on pointer/touch; focus-trapped D-pad modal on TV), enforces device-local platform defaults, upgrades Profiles into a redesigned **"Who's Watching?"** overlay with 9 original circular vector avatars and Adult/Kids creation, turns Settings -> Profiles into a default-off **Kids Mode**, and simplifies Source management (3-button card + Advanced popup with Rename & Shared Profiles, M3U-first Add Source, QR modal URL wrap fix).

## Key Architectural Decisions
1. **Device-Local Platform Defaults:** `ArtworkCacheLimitMbPref` expands to `64 | 128 | 256 | 512` (`ARTWORK_CACHE_MAX_MB = 512`), with `getPlatformDefaultArtworkCacheLimitMb`: TV/Fire OS `128`, Phone/Tablet `256`, Desktop `512` — strictly excluded from Cloud Sync.
2. **9 Local Vector Avatars (Zero Schema Bump):** `PROFILE_AVATAR_TOKENS` expands cleanly from 6 to 9 (`crimson`, `sapphire`, `amber`, `violet`, `emerald`, `slate`, `coral`, `teal`, `indigo`), rendered via illustrated circular SVG vector portraits in `ProfileAvatarBadge` (easy 1-folder swap later, 0 ms load, zero network/copyright risk).
3. **Source Rename & Per-Source Profile Sharing (Zero Schema Bump):** `renameSource(sourceId, name)` updates `sources.name`; `setSourceExcludedProfiles(sourceId, excludedProfileIds)` stores `excludedProfileIds` inside `sources.settings_json` so all newly created profiles automatically see all sources by default unless explicitly unchecked. `profile-scoped-catalog` filters excluded sources for the active profile.
4. **Unified Dropdowns & Platform Visibility:** Language, Artwork Cache Limit, Catalog/Guide Refresh Intervals (`3/6/12/24/48 h` + adjacent **Refresh now**), and Desktop Advanced Audio Output/Layout use `SettingsDropdownRow`. `confirmExitOnBack` is Android-only; `liveChannelSwitchMode` and the **Remote Keys** tab are TV-only; `preferHevcOverDolbyVision` is hidden on Desktop (and `hwdec=no` bug removed); Desktop `minimizeToTray` defaults `true` and stops both full & embedded live playback on hide-to-tray.
5. **Kids Mode & Redesigned "Who's Watching?":** Profile CRUD is removed from Settings; the tab becomes **Kids Mode** (default OFF, single toggle until enabled; PIN required to disable/edit or exit Kids profile). Top-right avatar opens "Who's Watching?" with hover/touch/TV edit pencil -> Edit modal (name, 9 avatars, Kids toggle, PIN manage, Delete profile) and `+` Add flow starting with Adult vs Kids selection.

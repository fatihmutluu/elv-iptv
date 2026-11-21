# Round 2 Slice 5 — Cinema Quietude Live TV Hub, Mini-Guide Zap Drawer, Number Jump & Virtualized 1000-Channel XMLTV EPG Grid

**Date:** 2026-11-21  
**Status:** Approved for implementation (autonomous Round 2)  
**Design Contract:** [UI_UX_PHILOSOPHY.md](../../design/UI_UX_PHILOSOPHY.md) §1, §2.1, §2.2, §3, §4  
**Refs:** `#6`, `#25`, `#54`, `#56`, `#250`

## 1. Goals & User Value
1. **Indexed Visible-Window XMLTV Guide & Number-Jump Queries (`@elv/data` + Electron IPC):**
   - `queryNowNext(db, channelKeys, nowMs)`: bounded (`<= 60` keys) Now & Next programme lookup joining `channel_guide` (`PK (source_id, channel_key)`) into `programmes` (`PK (source_id, guide_id, start)`) with zero full-table scan.
   - `queryEpgWindow(db, channelKeys, fromMs, toMs)`: bounded (`<= 40` keys) time-window query returning programmes overlapping `[fromMs, toMs]` ordered by `start`, sustaining `< 15 ms` on 1,000-channel × 7-day schedules.
   - `queryChannelByNumber(db, num, sourceId?)`: O(log N) lookup via `idx_live_num` (`(source_id, num)`) powering `0–9` channel jumping (`#54`).
   - Exposes `importGuide?(sourceId, opts?)` on `CatalogService` serialized safely with `importSource` and `removeSource` (`#25`), wired end-to-end across Electron IPC, `createLazyCatalog`, and rich synthetic multi-hour EPG data in `mock-catalog`.
2. **Unified Cinema Quietude Live TV Hub (`@elv/features/src/live/`):**
   - Single `Live` top-level tab hosting the 3-mode Live Switcher (`Watch` | `Channels` | `TV Guide`), keeping global navigation strictly 4+2.
   - **Watch Stage:** Quick-launch active live channel stage with toggleable **Mini-Guide Zap Drawer** (virtualized channel list + category chips + live Now show), **Number Pad (`0–9`)** with physical digit entry + auto-tune (`#54`), **Previous Channel** quick jump, Now/Next programme progress bar, and instant fullscreen playback.
   - **Channels Grid:** O(1)-memory row-virtualized channel grid (`maxDecodePx={160}`, `TABULAR_NUMS_STYLE` numbers, live Now/Next titles & progress bars via bounded in-memory TTL cache `#250`) with category `FilterChip`s.
   - **TV Guide (EPG) (`#6`, `#56`):** Top focused-channel preview header (`Watch now` CTA + `Refresh guide`), category filter chips, sticky `30m` Time Ruler + live accent `Now` line + `Jump to live`, and O(1) virtualized 1,000-channel × 7-day timeline matrix preserving D-pad focus on the programme spanning `anchorTimeMs` across scroll and recycling.

# Wave P5 — Offline VOD Movies & Series Downloads, Top Nav Downloads Destination & Cross-Media Multi-View

Date: 2026-11-26
Status: Approved (autonomous execution)

## Scope (Strictly VOD Movies & Series Episodes ONLY — Never Live TV)

### 1. Domain & SQLite v21 Offline Downloads Layer (`@elv/domain`, `@elv/data`)
- **Domain Types (`packages/domain/src/downloads.ts`):**
  - `DownloadMediaKind = 'movie' | 'episode'` (strictly VOD — Live TV channels are forbidden).
  - `DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'canceled'`.
  - `DownloadRecord` (`id`, `profileId`, `sourceId`, `itemKey`, `kind`, `title`, `seriesTitle?`, `season?`, `episodeNum?`, `poster?`, `localFileName`, `localUri`, `bytesDownloaded`, `totalBytes`, `status`, `errorCode?`, `createdAt`, `updatedAt`, `completedAt?`).
  - `DownloadEnqueueInput`, `DownloadProgressUpdate`, pure helpers (`computeDownloadProgressRatio`, `formatDownloadBytes`, `isPlayableDownload`, `isValidManagedDownloadFileName`).
- **SQLite Migration v21 (`packages/data/src/schema-v21.ts`, `schema.ts`, `schema-expected.ts`):**
  - `downloads` table keyed by `(profile_id, item_key)` with status, progress byte counters, managed `local_file_name`, metadata, timestamps, and indexes (`idx_downloads_profile_status`, `idx_downloads_source`).
  - `packages/data/src/downloads-repo.ts`: CRUD (`upsertDownload`, `updateDownloadProgress`, `setDownloadStatus`, `getDownload`, `listDownloads`, `deleteDownload`, `deleteDownloadsBySource`), exposed as optional methods on `CatalogService` + forwarded in `createProfileScopedCatalog` + `createObservedCatalog` + Desktop Catalog IPC (`catalog-ipc*.ts`, `catalog-worker-user-state.ts`, `catalog-bridge.ts`, `desktop-catalog.ts`).
- **Playtime Local Download Resolution (`packages/data/src/stream-resolver.ts`):**
  - Keep `isAllowedPlaybackUrl` strictly rejecting arbitrary `file://` URLs!
  - Add an opt-in managed local download check (`isManagedLocalDownloadUrl` / `resolveLocalDownload` hook) so completed managed downloads resolve to a `StreamRequest` marked `isLocalOffline: true` without touching network credentials or provider connections.

### 2. Strictly Scoped Managed-Downloads `file://` Allowlist (Desktop, Android Media3, Apple Aether)
- **NEVER allow arbitrary `file://` URLs anywhere!** Every platform enforces strict containment inside the app-private `downloads/` directory with symlink/traversal rejection:
  - **Desktop (`apps/desktop/src/main/downloads/managed-path.ts` + `apps/desktop/src/shared/player-ipc.ts` + `apps/desktop/src/main/player/ipc.ts`):**
    - `isStreamUrl` in `player-ipc.ts` continues rejecting arbitrary `file://` unless it uses a strictly validated managed download URI (`file://` with zero `..`, zero query/hash, allowlisted video container extension `.mp4/.mkv/.ts/.m4v/.webm/.mov`) AND in main-process `player/ipc.ts` (`load` / `queueNext`) BEFORE handing any `file://` URL to `mpv`, verify via `validateManagedDownloadPath(downloadsRoot, fileUrl)` (`realpath` + `!lstat.isSymbolicLink()` + `resolved.startsWith(realRoot + path.sep)` + `isFile()`) — rejecting any escape!
  - **Android Media3 (`modules/engine-media3/.../LoadRequest.kt`):**
    - Keep `isAllowedPlaybackUrl` rejecting arbitrary `file://`; add `isAllowedManagedDownloadFileUri(url, managedDownloadsDir)` verifying canonical path containment inside `context.filesDir/downloads` with zero `..` traversal, zero query/fragment, and zero Android external storage permissions!
  - **Apple Aether (`modules/engine-aether/ios/Core/MediaPlan.swift`):**
    - Keep `planMedia` rejecting arbitrary `file://`; add explicit optional `allowedDownloadsRoot: URL?` containment check (`standardizedFileURL.resolvingSymlinksInPath()`) strictly confined to the app's private `downloads/` folder!

### 3. Desktop Offline Download Runner (`apps/desktop/src/main/downloads/`) & `max_connections = 1` Coordination
- Real streaming HTTP/HTTPS downloader (`apps/desktop/src/main/downloads/download-manager.ts`) writing into `<userData>/downloads/<sanitized-id>.<ext>` via `.part` temp file + atomic rename on completion, supporting:
  - Queueing, Pause (`AbortController`), Resume (HTTP `Range: bytes=<offset>-` when server responds `206`, clean restart on `200`), Cancel, and Delete (removing both disk file + DB record).
  - Pre-flight disk space & filename safety validation, zero credential logging, zero symlink escapes.
  - **`max_connections = 1` Online Playback Auto-Pause:** Whenever an online/live playback session begins (`notifyOnlinePlaybackActive(active: boolean)`), automatically pause active downloading jobs for contending sources (`autoPausedForPlayback`) and automatically resume them when online playback ends!
  - Exposed via `apps/desktop/src/shared/downloads-ipc.ts`, `apps/desktop/src/main/downloads/ipc.ts`, `apps/desktop/src/preload/downloads-bridge.ts`, `apps/desktop/renderer/src/downloads/desktop-downloads-port.ts` (and registered in `main.ts` & `preload.ts`).
- Cross-platform `DownloadManagerPort` in `packages/features/src/ports/downloads-port.ts`:
  - Desktop connects the full real disk downloader.
  - TV/Mobile connects a clean SQLite-backed download state port (`apps/tv-mobile/src/downloads/`) reporting supported capabilities gracefully without adding native external dependencies.
- **Zero-Connection Local Playback:** Playing a completed offline download (`PlayTarget.isLocalOffline === true` or resolved local download URI) bypasses `ConnectionTracker` / `useConnectionLimitGuard`, consuming **0 provider connections**!

### 4. Top Nav `Downloads` (`İndirilenler`) Destination (`5 + 2`) & Download Triggers
- Update `buildShellDestinations` (`packages/features/src/app-shell-state.ts`) and `docs/design/UI_UX_PHILOSOPHY.md` to **`5 + 2`**: `Home | Live TV | Movies | Series | Downloads` + `Search` & `Settings`!
- Build **`DownloadsScreen`** (`packages/features/src/downloads/`):
  - Cinema Quietude layout with active progress queue (progress bar, downloaded/total MB, Pause / Resume / Cancel controls) + completed Movies & Series cards (1-click Play offline, Open in Multi-View, Delete download, Right-click/Long-press `ContextMenu`) + clean empty state + full 10-ft TV D-pad navigation!
- Add **Download** CTAs cleanly to:
  - `DetailHero` (Movie download button with live state: Download -> Progress % -> Downloaded ✓),
  - `DetailEpisodeRow` (compact per-episode Download icon/progress button with tooltip),
  - Movie & Series card right-click/long-press Context Menus (`Home`, `Catalog`, `Search`).

### 5. Cross-Media Multi-View (Live + Movies + Series + Dedicated `Downloads` Filter)
- Extend `MultiViewTile` (`packages/playback/src/multiview-controller.ts`), `useMultiViewSession.ts`, `MultiViewStage.tsx`, and `PlayerScreen.tsx` so Multi-View supports **Live TV, Movies, Series Episodes, AND Downloaded offline items** (`kind: 'live' | 'movie' | 'episode'`, `isLocalOffline?: boolean`)!
  - Allow entering Multi-View from Live TV, Movies, AND Series playback (`PlayerScreen.tsx` & `playerSettings` overflow menu)!
  - Downloaded offline tiles (`isLocalOffline: true`) bypass `ConnectionTracker` so a user on a `max_connections = 1` account can watch **1 Live TV channel + 1 Downloaded Movie or Series Episode side-by-side** with zero connection-limit error!
- Upgrade **`MultiViewChannelPicker.tsx`** with borderless Cinema Quietude editorial filter tabs:
  - **`Live` (`Canlı`) | `Movies` (`Filmler`) | `Series` (`Diziler`) | `Downloads` (`İndirilenler`)**!
  - Selecting `Downloads` lists completed offline Movies & Series Episodes immediately (showing a subtle `Offline · 0 conn` / `Çevrimdışı` caption) so users can pair any downloaded title right next to a live broadcast without consuming a provider connection!

## Verification
- Strict TDD across `@elv/domain`, `@elv/data`, `@elv/playback`, `@elv/i18n`, `@elv/features`, `@elv/desktop`, `@elv/tv-mobile`, `modules/engine-media3`, `modules/engine-aether`.
- `pnpm.cmd check`: `11 passed, 0 failed`.
- Independent `Gemini 4 Neon (High)` whole-branch code review before PR merge.

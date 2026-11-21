# Round 2 Slice 14 — Desktop Zero-Jank Scroll Compositing, MediaSession, Modal Focus Trap & Credential-Fingerprint Connection Pooling

## 1. Objective
Close four high-impact performance, desktop ergonomics, accessibility, and multi-source connection-safety issues (`#156`, `#166`, `#265`, `#283`) across `@elv/data`, `@elv/features`, and `apps/desktop` while maintaining strict pure-package boundaries, Cinema Quietude visual polish, and zero UI-thread jank.

## 2. Deliverables & Contracts

### 2.1 Cross-Source Credential Fingerprint & Connection Pooling (`#265`, `@elv/data`)
- **`packages/data/src/credential-fingerprint.ts` (pure TypeScript, zero `node:*`):**
  - Pure-TS SHA-256 (`sha256Hex`) deriving opaque non-reversible fingerprints (`fp:<64-hex>`) from normalized `(host[:port], username, password)` — never persisting or logging raw credentials or hostnames.
  - `extractM3uUrlCredentialTuple(url)` extracting `(host[:port], username, password)` from:
    1. Typed Xtream M3U paths: `/(live|movie|series)/<user>/<pass>/<id>...`
    2. Short-form Xtream M3U paths: `/<user>/<pass>/<id>[.ext]` (excluding reserved roots like `live`, `movie`, `movies`, `series`, `vod`, `hls`, `dash`, `stream`, `streams`, `play`, `api`, `tv`, `channel`, `channels`, `playlist`, `playlists`, `epg`, `xmltv`, `static`, `media`, `content`, `cdn`, `video`, `videos`, `audio`, `files`, `public`, `assets`, `v1`, `v2`)
    3. Query-string credentials (`?username=<u>&password=<p>`)
  - Export `fingerprintXtreamCredentials(server, username, password)`, `fingerprintM3uCredentials(playlistUrl, sampleStreamUrls?)`, and `resolveAccountPoolKey(source: { id: string; credentialFingerprint?: string })`.
- **`packages/data/src/sources.ts`, `import-xtream.ts`, `import-m3u.ts`, `catalog.ts`, `stream-resolver.ts`, `index.ts`:**
  - Persist `credentialFingerprint?: string` in `SourceSettings` during Xtream and M3U imports, expose `credentialFingerprint?: string` on `SourceRow` (when present) and `accountKey?: string` (`credentialFingerprint ?? sourceId`) on `StreamRequest`.
  - Add pure `createConnectionPool(maxConnectionsByPool?)` / pooling helper in `packages/data/src/credential-fingerprint.ts` proving two distinct sources (e.g. an Xtream source + an M3U source) backed by identical credentials share a single pool key and connection budget without exposing secrets.

### 2.2 Desktop Zero-Jank Scroll Blur Throttling, `navigator.mediaSession`, Virtual-Grid Padding Math & Route Effect Freeze (`#156`, `#166`)
- **`apps/desktop/renderer/src/scroll-blur-guard.ts` & `App.tsx` (`#156`):**
  - `attachScrollBlurGuard(win, { settleMs = 120 })`: injects `<style id="elv-scroll-blur-guard">` suspending `backdrop-filter` / `-webkit-backdrop-filter` ONLY while `document.documentElement.classList.contains('elv-scrolling')`, and toggles `elv-scrolling` on scroll capture throttled via `requestAnimationFrame` (clearing `120 ms` after last scroll event) so 100k grids and EPG timelines stay locked at 60/120 fps on integrated GPUs.
- **`apps/desktop/renderer/src/media-session.ts` (`#166`):**
  - `createDesktopMediaSession(navigatorLike?)`: updates `navigator.mediaSession.metadata`, `playbackState`, and `setPositionState` (clamped finite VOD values), registers `play`, `pause`, `seekbackward`, `seekforward`, `seekto`, `previoustrack`, and `nexttrack` action handlers cleanly, guards unsupported environments, and cleans up on `clear()` / `dispose()`.
- **`packages/features/src/catalog/virtual-grid-math.ts` & `CategoryGridView.tsx` (`#166`):**
  - Pure `computeVirtualGridScrollOffset({ rowIndex, rowStride, paddingTop?, borderTopWidth?, viewportHeight?, align? })` accounting accurately for container `paddingTop` and `borderTopWidth` in virtual-grid `scrollTo` offset math; wired cleanly into `CategoryGridView.tsx`.
- **`packages/features/src/shared/useRouteActive.ts` & `AppShell.tsx` (`#166`):**
  - `RouteActiveProvider` / `useRouteActive()` / `useActiveEffect()` / `useDocumentVisible()` freezing background/offscreen route watchers (such as `EpgGridView`'s live clock) when hidden while keeping persistent player state responsive.

### 2.3 Desktop Player Dialog Focus Trapping, Inert Isolation, `aria-keyshortcuts`, Fullscreen Popover Guard & Pool Key Wiring (`#283`, `#265`)
- **`packages/features/src/player/desktop-dialog-trap.ts` (`#283`):**
  - Pure web DOM focus-trap + background `inert` helper `attachDesktopDialogTrap(dialogEl, { onEscape?, restoreFocus? })`: captures `previousFocus`, marks sibling subtrees outside the dialog ancestor chain `inert = true` (restoring exact prior `inert` state on teardown), cyclically traps `Tab` / `Shift+Tab` inside focusable descendants, and restores `previousFocus` on close when still connected.
- **`TrackPickerModal.tsx`, `PlayerSettingsSheet.tsx`, `PlayerScreenParts.tsx`, `PlayerScreen.tsx`, `usePlayerOverlayState.ts`, `usePlayerTargetHandoff.ts`, `ports/play-target.ts` (`#283`, `#265`):**
  - Attach `attachDesktopDialogTrap` to desktop `TrackPickerModal` and `PlayerSettingsSheet` when open (`formFactor === 'desktop'`, keeping desktop native-HWND flex-flow safety intact!).
  - Expose synchronized `aria-keyshortcuts` (`Space`, `k`, `j`, `l`, `m`, `f`, `c`, `Escape`) on desktop player OSD buttons (`PlayerScreenParts.tsx`).
  - Collapse open popovers/sheets (`tracksOpen`, `settingsOpen`) cleanly BEFORE invoking fullscreen (`toggleFullscreen`) to prevent Chromium popover-ancestor compositor issues.
  - Add optional `accountKey?: string` to `PlayableEntry` / `PlayTarget` and wire `entry.accountKey ?? entry.sourceId` in `usePlayerTargetHandoff.ts` (`#265`).

## 3. Verification Plan
- Strict TDD (`RED -> Verify RED -> GREEN -> Verify GREEN`) with `>= 90%` line coverage on `@elv/data`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2 passed`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

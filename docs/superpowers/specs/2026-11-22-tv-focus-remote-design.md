# Wave 3B — TV Focus, Remote Input & 10-Foot Parity Design

**Issues:** `#425`, `#439`, `#112`, `#130`, `#277`, `#281`  
**Status:** Active  
**Date:** 2026-11-22

## 1. Goals & Invariants
Eliminate Android TV / Fire OS / tvOS remote-input traps, dead-end focus states, duplicate-Select modal glitches, split overlay auto-hide races, and 960×540dp vs 1920×1080pt 10-foot proportion drift — while preserving the `gate-list` hot-path performance budget (`TvList.tsx`, `use-key-interpreter.ts`, `key-source.ts`, `ElvRemoteKeysModule`).

## 2. Architecture by Issue

### 2.1 `#425` — Android TV Root `BackHandler` Exit Propagation
- Extend `packages/ui-kit/src/tv/remote-context.ts` with `markEventConsumed(event)` / `isEventConsumed(event)` (`WeakSet<TvRemoteEvent>`) and change `TvRemoteDispatcher.dispatch(input, requirePriorDown)` to return `boolean` (`true` if text-entry exit or any subscriber consumed the event, `false` otherwise).
- Widen `useTvKeySource` and `useKeyInterpreter` handler signatures to `(event) => boolean | void`:
  - Returning `false` explicitly marks the event unconsumed.
  - Returning `true` (or `undefined` for existing handlers that do not opt out, except when `listeners.size === 0`) marks the event consumed.
- In `attachPlatformKeySource` (`remote-dispatcher.ts`):
  - Track `lastRawBackConsumed` alongside `pendingRawBackUp` / `lastRawBackUpAt` so when Android `BackHandler` (`hardwareBackPress`) fires immediately after a raw `ACTION_UP` on `KEYCODE_BACK`, it returns `lastRawBackConsumed` (allowing clean OS exit when root Back was unconsumed, and preventing double-back when consumed).
  - For fallback `BackHandler` paths (without prior raw Back up), return `emit({ key: 'back', action: 'press', time: now }, false)`.
- In `AdaptiveNavShell` & `AppShell`:
  - Add optional `onBack?: () => boolean` to `AdaptiveNavShellProps`.
  - When `topNavFocused` is active, pressing `back` delegates to `onBack?.()`: on non-Home tabs `AppShell` switches to `'home'` and returns `true`; on the root `'home'` tab with no overlay/detail/player open, `onBack` returns `false`, letting Android TV exit cleanly to the system launcher.

### 2.2 `#439` — Android TV `remote-keys` Hardening, Extended TV Keycodes & Hidden-OSD Transport Pass-Through
- **Kotlin `KeyForwarding.kt` (`modules/remote-keys`):**
  - Replace `WeakHashMap<Any, Boolean>` with `WeakHashMap<Any, WeakReference<ForwardingWindowCallback>>` (preserving GC collectability of destroyed activities/windows).
  - On `wrapWindow(windowKey, callback)`, check if `callback` is already `ForwardingWindowCallback` or delegates to the recorded `ForwardingWindowCallback` in its field/wrapper chain (bounded depth 6). If a third-party library wrapped our callback, do not double-wrap; if an SDK/DevSupport replaced `window.callback` completely, detect the missing wrapper and re-wrap cleanly.
  - Add modal/dialog window forwarding helper (`installModalWindows(activity)` / `wrapDialogWindow`) using public Android API 29+ `WindowInspector.getGlobalWindowViews()` (and safe reflection-free context/Dialog unwrapping) when modal focus shifts occur, plus `ElvRemoteKeysModule.kt` hooking foreground and focus-loss transitions so RN `<Modal>` / `Dialog` windows forward keys.
- **Extended Keycodes (`packages/focus-core/src/keys.ts`, `android-keys.ts`, `remote-dispatcher.ts`, `web-keys.ts`):**
  - Extend `Key` with `'stop' | 'next' | 'previous' | 'captions' | 'audioTrack' | 'guide' | 'info' | 'search' | 'lastChannel'`.
  - Map Android keycodes: `86` (`stop`), `87` (`next`), `88` (`previous`), `175` (`captions`), `222` (`audioTrack`), `172` (`guide`), `165` (`info`), `84` (`search`), `229` (`lastChannel`), plus gamepad `100` (`BUTTON_Y` -> `search`), `102` (`BUTTON_L1` -> `channelDown`), `103` (`BUTTON_R1` -> `channelUp`).
  - Map matching `TVEventHandler` event names in `remote-dispatcher.ts`.
- **Player Hidden-OSD Transport Pass-Through & Fullscreen Live Controls (`packages/features/src/player/usePlayerControls.ts`):**
  - When `isTv && s.osdHidden`, channel zap (`channelUp`/`channelDown`) executes without forcing OSD open; transport and media keys (`playPause`, `play`, `pause`, `rewind`, `fastForward`, `stop`, `next`, `previous`, `captions`, `audioTrack`, `info`, `lastChannel`, and `digit0..9`) wake OSD AND fall through to execute immediately rather than being swallowed.
  - Wire fullscreen Live TV `playPause` / `play` / `pause`, `0-9` direct channel number entry (`onChannelNumber` / channel-digit buffer), `stop` (exit), `next` / `previous` (next episode or channel zap / previous channel), `captions` / `audioTrack` (open tracks sheet), `info` (toggle stats / wake OSD), and `lastChannel` (`onJumpPreviousChannel`).

### 2.3 `#112` — 10-Foot Focus Preservation Across Empty Panels, Routes & Time-Overlap EPG Rows
- **`focus-core` (`scope.ts`, `store.ts`):**
  - When `createScope` / `pushScope` initializes with an `active` list whose `count === 0`, immediately resolve `resolveFallbackId` to a non-empty fallback when available so focus never starts stranded on an empty panel.
  - Expose an `emptyFallback` / `hasNonEmptyList` check and emit an `'emptyScope'` intent (or fallback notification) when `setCount` empties the active list with no non-empty fallback in the scope so parent rails/toolbars can reclaim focus.
- **Route Focus Tokens (`BrowseFocusMemory` + `DetailScreen`):**
  - Keep placeholder focus tokens across async screen hydration until matching items arrive or user navigates manually (building on Wave 3A's `BrowseFocusMemory`).
- **Time-Overlap EPG Row Selection (`packages/features/src/live/live-model.ts`, `useEpgTimeCursor.ts`):**
  - Add pure `findOverlappingProgramIndex(programmes, windowStartMs, windowStopMs, fallbackAnchorMs)` that selects the programme with maximum `[start, stop]` intersection duration against the originating programme's interval (breaking ties by nearest `start`, falling back to `findProgramIndexAtTime(..., fallbackAnchorMs)` on gaps).
  - Use it in `useEpgTimeCursor.ts` on vertical `up`/`down` row movement.

### 2.4 `#130` — RN TV Focus Traps, Double-Select Modals & RTL Seek Sliders
- Gate `TvFocusAnchor`'s `hasTVPreferredFocus` on `PlayerScreen` (`!tracksOpen && !settingsOpen && !locked`) and on browse tab-root screens (`routeActive && !topNavFocused`) so inactive tabs and background anchors never steal TV focus.
- Wire `createSelectDebounceGuard` (`@elv/focus-core`) in `usePlayerControls.ts` for sheet/modal toggle & select activations so duplicate Android TV `Select` events in a single batch never double-open or double-pop sheets.
- Restore TV OSD focus back to the opener action (`'tracks'` / `'settings'`) when closing `TrackPickerSheet` or `PlayerSettingsSheet` on TV.
- Force `direction: 'ltr'` on `VodProgressBar.tsx`, `EpgChannelRow.tsx`, and `EpgPreviewHeader.tsx` timeline tracks so RTL locales never invert seek progress or time bars.

### 2.5 `#277` — Single `TVRemoteDispatcher` Lifecycle & Single-State Overlay Timeout
- Add optional `{ onFirstListener?: () => (() => void) | void; onLastListener?: () => void }` lifecycle hooks to `createTvRemoteDispatcher` (`remote-dispatcher.ts`) so `TvRemoteProvider` attaches its single platform listener only when `subscriberCount` transitions `0 -> 1` and detaches only on `1 -> 0` (eliminating idle listener overhead and per-card churn).
- Consolidate `useOsdAutoHide.ts` onto a single atomic state `{ armed: boolean; restartCounter: number }` managed via `useReducer` so rapid D-pad navigation (`showOsd` + `notifyOsdActivity` within one commit) never cancels a freshly scheduled timer across split effects.

### 2.6 `#281` — Android TV 1080p Logical Scaling & Sibling `TVFocusGuideView` Regions
- Keep Android native `DisplayMetricsHolder` untouched (so `Media3SurfaceView` and `SubtitleView` geometry remain exact) and normalize 10-foot UI proportions in JS via `viewport.tvScale` + `scaleTv(px, viewport)` (`packages/ui-kit/src/viewport/resolve-viewport.ts`), applied in `AdaptiveNavShell` and shared TV chrome.
- Add `TvFocusGuideRegion` (`packages/ui-kit/src/tv/TvFocusGuideRegion.tsx`), wrapping React Native TV's `TVFocusGuideView` with `enabled={enabled}` (never `display: 'none'`, per `#130`), falling back to `View` on web and non-TV platforms. Wire non-nested sibling `TvFocusGuideRegion` blocks in `AdaptiveNavShell`, `HomeRail`, and `CatalogRailsBody`.

## 3. Verification Plan
- Pure package tests (`@elv/focus-core`) >= 90% line coverage.
- Jest & Vitest suites across `@elv/ui-kit`, `@elv/features`, `tv-mobile`, and `@elv/desktop`.
- Android JVM unit tests (`:elv-remote-keys:testDebugUnitTest`) via Gradle.
- Full `pnpm check` (`11 passed, 0 failed`) + independent `Gemini 4 Neon (High)` whole-branch code review.

# Round 2 Slice 12 — Playback Resilience, Redacted Diagnostics, Exact-Origin Security & TV Crash Recovery

## 1. Objective
Close four `priority:high` stability, diagnostics, transport-security, and input/runtime-recovery issues (`#139`, `#159`, `#302`, `#316`) across `@elv/domain`, `@elv/playback`, `@elv/i18n`, `@elv/features`, and `apps/desktop` while maintaining strict pure-package boundaries, Cinema Quietude design fidelity, and zero UI-thread jank.

## 2. Deliverables & Contracts

### 2.1 Coalesced Playback-Speed Changes, Redacted `PlaybackDiagnoser` & Monotonic Clocks (`#302`, `#316`, `#159`)
- **`packages/playback/src/clock.ts`:**
  - Export `createMonotonicClock(nowFn?): PlaybackClock` returning strictly non-decreasing timestamps (`performance.now()` with monotonic floor guard) immune to backwards wall-clock NTP/broadcast time jumps.
- **`packages/playback/src/speed-coalescer.ts` & `service.ts` / `engine.ts` / `types.ts` (`#302`):**
  - Add optional `setSpeed?(attempt: AttemptToken, rate: number): void` on `PlayerEngine` and `setSpeed(rate: number): void` on `PlaybackService` (clamping valid finite rates to `[0.25, 4.0]`).
  - Queue the latest `pendingSpeed` while `seekCoalescer.isPending()` or a prior speed transition is in flight, flushing ONLY the latest coalesced value once settled so rapid speed steps during an active seek never trigger overlapping flush-seeks or IPC storms.
  - Implement `setSpeed(attempt, rate)` on `MpvEngine` (`apps/desktop/src/main/player/engine.ts`) coalescing pending `['set_property', 'speed', rate]` commands while seek/speed IPC is in flight.
- **`packages/playback/src/diagnoser.ts` (`#316`):**
  - Export `DEFAULT_ACCOUNT_HEALTH_TTL_MS = 60_000`, `PlaybackVerdict`, `AccountHealthSnapshot`, `PlaybackDiagnosisInput`, `PlaybackDiagnosis`, `diagnosePlaybackFailure(input)`, and `createPlaybackDiagnoser({ clock, checkAccountHealth?, ttlMs? })`.
  - Combines `online` connectivity, `bytesReceived`, `httpStatus`, `error`, and 60s-TTL monotonic-cached `accountHealth` into actionable verdicts (`offline`, `account-expired`, `account-disabled`, `connection-limit`, `auth-failed`, `not-found`, `server-silent`, `codec-unsupported`, `upstream-error`, `network-error`, `unknown`) plus a strictly host-only redacted `evidence` line (`host=<hostname[:port]> status=<code> bytes=<n>` — never credentials, paths, or query params).
- **`apps/desktop/src/main/player/mpv/process.ts` & `process-darwin.ts` (`#159`):**
  - Replace all wall-clock `Date.now()` deadline math with monotonic `performance.now()`.

### 2.2 Exact-Origin Credential Headers, IME Composition Guard, Touch-Hover Suppression & Desktop Mouse Back (`#139`)
- **`packages/domain/src/headers.ts` & `packages/domain/src/http.ts`:**
  - Export `originOf(url)`, `sameOrigin(a, b)` (scheme + lowercase host + default-port normalized `http:80`/`https:443`), and `scopeCredentialHeaders(headers, initialUrl, targetUrl)` stripping `Authorization`, `Proxy-Authorization`, and `Cookie` whenever target origin differs from initial origin.
  - Sanitize outbound request headers via `sanitizeHeaders` in `createFetchHttpClient`; when credential headers are present, manually follow redirects (max 10 hops, `redirect: 'manual'`) and strip credential headers on any cross-origin redirect hop!
- **`packages/features/src/search/SearchScreen.tsx` & `packages/features/src/sources/SourcesScreen.tsx`:**
  - Guard `isComposing` / `keyCode === 229` on `Enter` key handlers so IME composition commits never submit prematurely.
- **`packages/features/src/player/touch-hover-guard.ts`, `PlayerScreen.tsx`, `usePlayerOverlayState.ts`:**
  - Pure monotonic-clock `createTouchHoverGuard(clock, suppressMs = 500)` suppressing synthetic `onMouseMove`/`onPointerMove` hover wake-ups within 500 ms after touch input (`onTouchStart` / `pointerType === 'touch'`) so mobile/tablet OSD auto-hide works reliably.
- **`apps/desktop/src/main/browser-back.ts`, `main.ts`, `apps/desktop/renderer/src/App.tsx`:**
  - Intercept Electron `BrowserWindow` `app-command` `'browser-backward'` and renderer mouse Back button (`button === 3` on `mouseup`/`auxclick`) cleanly, preventing broken Chromium history navigation and dispatching Escape/Back into the app shell.

### 2.3 Cinema Quietude TV-Navigable `CrashRecoveryBoundary` & Actionable Player Diagnosis UI (`#159`, `#316`)
- **`packages/i18n/src/locales/en.ts` & `tr.ts`:**
  - Add EN + TR keys for `crash.*` (`title`, `subtitle`, `reload`, `clearCache`, `switchSource`) and `player.diag.*` (`offline`, `accountExpired`, `accountDisabled`, `serverSilent`, `codecUnsupported`).
- **`packages/features/src/shell/CrashRecoveryBoundary.tsx` & `AppShell.tsx`:**
  - Cinema Quietude React Error Boundary (100% theme tokens, zero hardcoded hex colors, graceful token/copy fallback if thrown outside providers) offering three TV/D-pad, keyboard, and touch-navigable recovery actions: **Reload** (`crash-reload`), **Clear UI Cache** (`crash-clear-cache`), and **Switch Source** (`crash-switch-source`), with a redacted error-code-only summary (never raw URLs/credentials).
  - Wrap `AppShell` stage content cleanly so a screen render crash never leaves the user trapped on a blank TV/desktop/mobile screen.
- **`packages/features/src/player/errors.ts` & `PlayerScreenParts.tsx`:**
  - Wire `diagnosePlaybackFailure` (`#316`) into `describePlaybackFailure` and `PlayerOsd` to display actionable localized verdict copy plus optional subtle host-only redacted evidence (`testID="player-error-evidence"`).

## 3. Verification Plan
- Strict TDD (`RED -> Verify RED -> GREEN -> Verify GREEN`) with `>= 90%` line coverage on `@elv/domain` and `@elv/playback`.
- Full `pnpm check` (`11 passed, 0 failed`), Desktop prod bundle (`WORKBENCH_HITS=0`), Windows Electron E2E (`browse-play.spec.ts` `2 passed`), and independent `Gemini 4 Neon (High)` whole-branch review (`VERDICT: PASS`).

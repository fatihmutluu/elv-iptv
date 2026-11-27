# Wave E3 Design Spec — Smart First-Run Onboarding, Live Interactive ELV Mode Preview & Returning-User Startup

> **Issue:** `#513` (Smart Onboarding, Live Interactive ELV Mode Preview & Returning-User Startup)
> **Design Contract:** `docs/design/UI_UX_PHILOSOPHY.md` (Cinema Quietude v2 — zero RN `<Modal>`, full 10-ft TV D-pad + desktop + touch parity, zero 1-frame startup blink, zero hardcoded hex chrome, clean public copy)
> **Date:** 2026-11-27

## 1. Architecture & Flow

### 1.1 Zero-Blink Startup Gate & Migration
- All startup overlay routing (`OnboardingFlowOverlay`, `StartupRefreshOverlay`, `ProfilePickerOverlay`) waits strictly for `preferences.ready && profile.profilesReady && sourcesResolved` so returning users never see a 1-frame flash.
- Upgrading users (`!onboardingCompleted && (welcomeDismissed || sources.length > 0)`) silently auto-migrate to `onboardingCompleted = true`.
- `DEFAULT_WAVE_F9_PREFERENCES.telemetryOptIn` remains `false` until the user explicitly proceeds past Screen 1 (zero pre-consent telemetry).

### 1.2 Screen 1 — Smart Welcome & Auth (`OnboardingWelcomeStep`)
- **Smart Email Flow:** User enters email -> checks account existence via rate-limited `POST /v1/auth/check-email` (gracefully falling back to password + inline 1-tap Create Account prompt if offline/unsupported/rate-limited):
  - Existing email -> prompts password -> signs in -> routes to Short Syncing Step (`OnboardingSyncingStep`).
  - Unregistered email -> displays inline prompt (*"No account found for this email — would you like to create one?"*) -> 1-tap password + confirm -> registers -> shows E2EE Recovery Code acknowledgment -> routes straight to Screen 2 (no blank syncing screen).
- **Guest Mode (`Continue without account`):** Proceeds directly to Screen 2 with local-only operation.
- **Transfer from Another Device:** Embeds Wave P9 `AccountBidirectionalPairingPanel` (Single-QR + 8-digit code) -> on completion routes to `OnboardingSyncingStep`.
- **OAuth-Ready Seam:** `SyncAccountPort` defines `OAuthProviderId = 'google' | 'apple'`, `supportedOAuthProviders?: readonly OAuthProviderId[]`, and `signInWithOAuth?(provider)` — currently empty so Google/Apple cards remain hidden until store credentials are configured.
- **KVKK / Privacy & Diagnostics Consent Strip:** Compact 2-line bottom strip opening an in-tree `PrivacyPolicyModal` on tap, with an inline anonymous diagnostics toggle defaulting ON for fresh onboarding confirmation (modifiable here or anytime in Settings).
- **Quiet Default Profile Assignment:** On new-user / guest progression, silently updates the SQLite-seeded `'default'` profile **in place** (never inserting a 2nd profile) with a friendly randomized cinema-themed name, 1 of the 9 built-in vector avatars, and `obsidianCrimson` theme preset.

### 1.3 Existing Account vs 0-User Branch (`OnboardingSyncingStep`)
- Existing account login or QR transfer shows a brief *"Syncing your data..."* step -> downloads encrypted vault.
  - `>= 1` IPTV source restored -> marks `onboardingCompleted = true` and enters Home directly (or `"Who's Watching?"` if `2+` profiles).
  - `0` sources -> continues to Screen 2 (Add First Source).

### 1.4 Screen 2 — Add First Source + Lifted Background Import Coordinator (`[5.3]`)
- M3U-first (`M3U` default, `Xtream Codes`, `Stalker`, plus LAN QR when available) with a subtle `"Browse without a source for now"` escape link at the bottom.
- Submitting a valid source hands off `catalog.importSource(...)` to a shell-lifted `useOnboardingImportCoordinator` (surviving step transitions cleanly without aborting!) and immediately advances to Screen 3 while displaying a slim persistent top progress bar (`OnboardingImportBar`).
- **Dynamic Bottom CTA & Provider Wait Rule:**
  - While importing: white `Continue` button + gentle tooltip (*"Waiting on your provider — this isn't on our end. Keep personalizing while it loads."*).
  - The instant import finishes: CTA switches to semantic success green **`Enter App`** + subtle secondary **`Continue customizing`** link underneath.
  - On import failure: top bar turns error-toned with inline **`Retry`** and **`Edit details`** actions.

### 1.5 Screen 3 — Shared Interactive 4-Card ELV Mode Preview (`ElvModeInteractivePreview`)
- Lives in `packages/features/src/shared/ElvModeInteractivePreview.tsx` (obeying `no-feature-to-feature`) and mounts identically in **both** Onboarding Screen 3 and `Settings -> ELV Mode`'s `previewSlot`.
- Showcases **4 original, royalty-free fictional cinema posters** (pure cross-platform RN `<View>` art layers — works identically on Desktop, Web, Android, TV, iOS, tvOS) reacting live to:
  1. Master **ELV Mode** switch (default ON)
  2. **Merge movie & series versions** (`elvMergeVersions`) — OFF splits into exaggerated duplicate raw copies
  3. **Enhance posters & ratings** (`elvEnrichMetadata`) — OFF shows exaggerated broken/raw IPTV cards & missing ratings
  4. **Organize categories** (`elvCategorySource === 'imdb'`) — OFF shows exaggerated raw IPTV spam folder names

### 1.6 Personalization Chain & Centered Waiting Stage
- While the provider finishes importing (or if the user clicks `Continue customizing`), steps sequentially through 4 compact cards:
  1. Profile Name & 9 Avatars
  2. Theme Selection (live mini preview; `obsidianCrimson` default)
  3. Home Screen Layout (live mini preview)
  4. Platform Quick Tips (Desktop / Mobile / TV specific)
- If all 4 cards complete while the provider is still importing, smoothly transitions to `OnboardingWaitingStage` (centered expanded progress bar + rotating cinema/motivation quotes), entering the app automatically on completion.

### 1.7 Returning-User Startup Refresh & Profile Entry Rule (`[5.4]`)
- When returning with `onboardingCompleted && sources.length > 0`, checks whether any source is due for catalog/guide refresh (`catalogRefreshHours` / `guideRefreshHours`).
- If due, displays `StartupRefreshOverlay` with progress bar, phase description, rotating cinema quotes, and **`Cancel / Continue with old data`**.
- Clicking cancel/continue immediately dismisses the overlay so the user browses cached data while the refresh **continues silently in the background** (never aborted on dismiss!) and refreshes catalog views cleanly on finish.
- **Startup Profile Rule:** `1` profile enters Home directly; `2+` profiles open `"Who's Watching?"` once on startup after onboarding/sync/refresh settles.

## 2. Verification
- Full `pnpm check` (`11 passed, 0 failed`), live Cloudflare Worker deploy for `/v1/auth/check-email`, desktop E2E updated for Wave E3 onboarding, independent whole-branch `Gemini 4 Neon (High)` review, CI green across all platforms, squash-merge closing `#513`.

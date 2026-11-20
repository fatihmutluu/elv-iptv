# Round 2 Slice 1 — Cinema Quietude Settings, Sources, Licenses & Clean Top-Bar IA

## 1. Goal & Scope
Bring ELV IPTV's first live Round 2 screens into the locked **Cinema Quietude** design language (`docs/design/UI_UX_PHILOSOPHY.md`) across Android TV, Fire OS, Apple TV, iOS/iPadOS, Android phone/tablet, Windows, macOS, and Linux:
1. **Settings screen (`packages/features/src/settings/`):** Categorized 2-column (Landscape) / horizontal chip-strip (Portrait) hub with three real, persisted sections:
   - **Appearance & Theme:** Live in-app Language picker (`System`, `Türkçe`, `English` — Refs `#16`), all 6 Cinema Quietude Theme Presets including **High Contrast (AAA)** (`Closes #325`), Text Scale (`90%–120%`), Reduce Motion toggle (`Closes #325`), and Reset to Defaults — all backed by `usePreferences()` (`PreferencesStore`) and updating the running app without restart.
   - **Sources & Playlists:** Cinema Quietude restyled `SourcesScreen` (zero hardcoded hex colors, segmented Xtream/M3U switcher, refined inputs, high-contrast neutral primary CTA, saved source cards with status pills & accent progress bars), preserving 100% of existing behavior, TV focus navigation, and `sources-*` test contracts.
   - **About & Licenses:** Compact About summary (`GPL-3.0-only + LGPL-2.1` + privacy/no-content statement) paired with Cinema Quietude restyled `ThirdPartyNoticesScreen` (100% theme-driven tokens, zero hardcoded dark-gray hexes, preserving offline TV/Phone/Desktop detail navigation).
2. **Clean Top-Bar IA (`packages/features/src/AppShell.tsx`):** Consolidate Round 1's temporary `Sources` + `Notices` utility links into a single sleek `Settings` utility icon button (`nav-tab-settings`) alongside `Live`, `Movies`, and `Series` (ready for `Home` in Slice 2 and `Search` in Slice 4). On an empty catalog (`sources.length === 0`), `AppShell` still launches directly onto `Settings → Sources` so `sources-screen` is immediately visible for first-run onboarding.
3. **Complete TR & EN Localization (`packages/i18n/`):** Every new Settings, Theme Preset, Language, and About string lives in `en.ts`, `tr.ts`, `locales/en/messages.po`, and `locales/tr/messages.po` with strict key and placeholder parity.
4. **Live Workbench & Desktop E2E Integration:** Sync `WorkbenchShell` `Live App` mode with an in-memory `PreferencesStore` via `AppProviders` so in-app Settings changes and the Workbench left inspector stay bidirectionally synchronized; update Desktop Playwright E2E (`browse-play.spec.ts`) for the consolidated Settings utility and verify live Settings theme/language switching.

## 2. Non-Goals (Deferred to Subsequent Slices)
- Unwired placeholder Playback toggles (HW decode, passthrough, AFR, buffer mode) — wait until wired to real engine configuration.
- `Home` screen, Hero Spotlight, Continue Watching, and My List — Slice 2.
- Movies/Series poster rails & Detail screen — Slice 3.
- Turkish-aware FTS5 Search & `add-language` skill (`#16` completion) — Slice 4.
- Live TV Mini-Guide & EPG grid — Slice 5.
- Player OSD & Desktop in-canvas overlay — Slice 6.

## 3. Architecture & Accessibility Guarantees
- **Zero hardcoded hex colors** in `@elv/features/src/settings/`, `sources/`, and `notices/` — every surface, border, input, error banner, switch, and focus ring derives from `useTheme().colors`.
- **WCAG AAA High Contrast & Reduce Motion (`#325`):** Verified under both default (`obsidianCrimson`) and `highContrast` presets; `reduceMotion` disables focus scaling and CSS transitions.
- **10-Foot TV D-Pad:** `SettingsScreen` uses `@elv/focus-core` for left-sidebar category switching and Appearance controls, delegating `isActiveScope` cleanly to embedded `SourcesScreen` and `ThirdPartyNoticesScreen` while routing `Back` / top-edge `Up` cleanly back to the sidebar and `AdaptiveNavShell` top nav.
- **Touch Targets:** Minimum `40×40` touch targets across Portrait and Landscape touch viewports.

# ELV IPTV — UI/UX Design Philosophy & Feature Placement Rulebook

> **Scope:** Binding UI/UX contract for Round 2 (`0.2`) and all future feature rounds (`0.3+`) across **Android TV, Fire OS, Apple TV (tvOS), Android Phone/Tablet, iPhone/iPad, Windows, macOS, and Linux**.
> **Rule for Every Implementing Agent:** Whenever you build a new screen, component, or user-facing feature in `@elv/ui-kit`, `@elv/features`, `apps/tv-mobile`, or `apps/desktop`, you MUST follow this philosophy and place the feature according to Section 2. Never invent ad-hoc tabs, boxed card styles, hardcoded dark colors, or extra player chrome.

---

## 1. Core Identity — "Cinema Quietude"

An IPTV player is **not** a SaaS admin dashboard, a glowing gadget, or a cluttered legacy set-top box. It is a **dark screening room**. The interface exists to recede behind cinema artwork, live broadcasts, and crisp typography, surfacing controls only at the moment of user intent.

### Core Design Pillars
- **Extreme visual restraint:** Pure-artwork poster cards with zero wrapper boxes or duplicate titles; sharp `4px` primary CTAs in neutral high-contrast white (`#FFFFFF` on `#09090B`); full-bleed hero artwork dissolving seamlessly into `--bg-canvas`.
- **Transparent-to-frosted navigation:** Top navigation sits cleanly over hero artwork with a top-down gradient (no bottom border at scroll `0`) and transitions smoothly into frosted glass (`backdrop-filter: blur`) with a `1px` hairline border when scrolled.
- **Tactile action hierarchy:** Circular frosted-glass secondary action icons (`+`, `👍`, `👎`, `↓`, `i`) paired with a wide neutral-white primary Play/Resume button; two-column Detail hero bottom (action stack left, synopsis & technical micro-badges right).
- **Clear aspect contrast:** Wide `16:9` cards are reserved exclusively for *Continue Watching* and *Live Broadcasts*; vertical `2:3` posters drive *Catalog Discovery* (Movies, Series, My List, More Like This).
- **Playback-first Live TV:** Entering `Live TV` starts live video immediately rather than dropping users into a sterile directory. `Channels` and `TV Guide (EPG)` live as seamless sibling sub-modes inside `Live TV`, keeping top-level navigation clean.
- **Uncluttered VOD player:** Center transport (`-10s`, `Play/Pause`, `+10s`), single interactive seekbar with hover/drag trickplay preview, and a compact **2-level Settings popover** (`Settings → Subtitles / Audio / Speed / Aspect / Stats`) that morphs into a slide-up bottom sheet on portrait devices.

### Strictly Forbidden Anti-Patterns
1. **Boxed poster cards:** Never wrap poster art + title inside a colored card container with borders. Posters are rounded artwork (`6px`) with minimal title/year/rating cleanly below.
2. **Duplicate titles:** Never print title/genre text over the poster image AND repeat the title underneath.
3. **ALL-CAPS eyebrow clutter:** Do not stamp tracked ALL-CAPS eyebrow labels above every heading. Use sentence case and quiet structural indicators (a `3px` accent bar or compact outlined micro-pills like `4K HDR`, `16+`).
4. **Uniform neon hover/focus outlines:** Never put a bright colored outline around a white Play button on desktop hover. Focus and hover treatments must be surface-aware.
5. **Hardcoded dark-blue scrims:** Every scrim and glass panel MUST derive dynamically from `var(--bg-canvas)` / `var(--bg-elevated)` so switching themes transforms the entire app coherently.
6. **Hardcoded or mixed-language copy:** 100% of user-facing strings route through `@elv/i18n` (Lingui) with complete `TR` and `EN` parity.

---

## 2. Information Architecture — "Where Does a New Feature Go?"

### 2.1 Default Top-Level Architecture: 4 + 2 (Config-Driven & Extensible)
Our **recommended default** top-level navigation is **4 primary destinations** + **2 utility endpoints** (`EPG`, `Favorites`, `Settings`, and `Sources` stay tucked inside their natural homes by default to preserve Cinema Quietude).

> **Modularity Rule:** Navigation components (`AdaptiveNavShell`, top bar, bottom tab bar) MUST be **100% data-driven** (`destinations: readonly NavDestination[]`, `utilities: readonly NavUtility[]`) — never hardcode a fixed 4-slot layout or magic tab indices in code. Adding, removing, or reordering a destination must be a clean configuration change, and intentional IA evolutions should update this living document alongside the change.

| Slot | Destination | Owns |
| :--- | :--- | :--- |
| **1. Home** | `home` | Full-bleed Hero spotlight carousel, *Continue Watching* (`16:9` wide rail), *On Air Now* (live broadcast rail + link to `TV Guide`), *My List* (dynamic favorites rail), *Featured Movies*, *Featured Series*. |
| **2. Live TV** | `live-player` | Playback-first live video + toggleable **Mini-Guide (Zap Drawer)** + **Unified Live Mode Switcher** (`Watch` \| `Channels` \| `TV Guide`) + **Number Pad (`0–9`)** + **Previous Channel**. |
| **3. Movies** | `movies` | Genre filter chips + category peek rails (`5.5` landscape / `3.5` portrait), each with `See all ›` drilling into a full vertical `category-grid`. |
| **4. Series** | `series` | Identical structural grammar to Movies: genre filter chips + category peek rails + `See all ›` full `category-grid`. |
| **Utility 1 (Right)** | `search` | Instant Turkish-tolerant search across Live Channels, Movies, and Series + scope filter chips (`All`, `Live`, `Movies`, `Series`) + recent searches + constructive empty state. |
| **Utility 2 (Right)** | `profiles` | Profile avatar opens full-screen Profile Picker (`Who's watching?`), which also provides secondary entry points to **Settings** and **Sources**. |

### 2.2 Feature Placement Decision Matrix
Before designing or coding any feature, locate its exact home here:

| Feature / Roadmap Area | Exact Placement | Design Rationale |
| :--- | :--- | :--- |
| **XMLTV EPG Grid & PiP Preview (`#6`, `#49`)** | Sub-mode inside **Live TV** (`Watch \| Channels \| TV Guide`) + quick link from Home's *On Air Now* header | EPG is a live-broadcast scheduling lens; keeps top nav permanently at 4 items. |
| **Channel Grid / Category Browse (`#13`)** | Sub-mode inside **Live TV** (`Channels`) + Mini-Guide category filter pills | Same live-TV family; zero friction between zapping and visual browsing. |
| **Number Jump (`#44`), Prev Channel (`#43`), Mini-Guide (`#48`)** | Top/left overlay controls inside **Live TV** + hardware remote shortcuts (`0–9`, `M`, `P`) | Living-room muscle memory without leaving video. |
| **Catch-Up (`#24`) & Live Time-Shift (`#25`)** | Inside **EPG** past slots (select past show → catch-up) & **Live TV** bottom scrub bar (when supported by source) | Contextual to the broadcast timeline; zero extra tabs. |
| **Program Reminders (`#35`)** | Action button in **EPG** preview header when a future program slot is selected | Only relevant when inspecting upcoming schedules. |
| **PiP / Multi-View (`#26`)** | Compact icon button in **Live TV / VOD Player** top-right utility cluster | Contextual playback mode, not a catalog destination. |
| **Subtitles, Audio, Speed, Aspect, A/V Sync, Dialogue Boost, Subtitle Styling, Stats (`#28`, `#51`, `#115`, `#351`)** | **2-Level Player Settings Popover** (`⋮` / quick `CC`, `Audio`, `Speed` icons top-right; morphs to Bottom Sheet on Portrait) | Keeps the video canvas clean while scaling smoothly to 8+ controls in 1–2 actions. |
| **Skip Intro (`#354`), Next Episode (`#353`)** | Floating high-contrast CTA anchored **bottom-right directly above the seekbar**, visible only during active intro/outro windows | Predictable spatial anchor; never competes with center transport. |
| **In-Player Cast & Scene Info (`#352`)** | Opt-in compact pill **bottom-left above the seekbar** expanding a single translucent horizontal cast strip on pause/click | Zero clutter during active playback; instant context when paused. |
| **Trickplay Thumbnails (`#356`) & Fine Scrubbing (`#355`)** | Inline `16:9` preview tooltip directly **above the seekbar thumb** during hover/drag | Direct spatial manipulation anchored to the timeline. |
| **Mobile Touch Lock (`#115`)** | Lock icon in Player top-right (Phone/Tablet only); hides all OSD leaving a single centered `Unlock controls` pill | Prevents accidental palm touches without adding desktop/TV chrome. |
| **Favorites / My List (`#14`)** | Circular `+` / `✓` toggle on Hero & Detail → populates the **My List** rail on **Home** | Removes the need for a separate Favorites screen. |
| **Watch Progress & Resume (`#14`)** | Bottom progress bar inside poster/still art + dedicated **16:9 Continue Watching** rail at top of **Home** + `Resume` CTA | Highest-frequency return action belongs immediately under the Home Hero. |
| **Sources (M3U / Xtream / Stalker), Sync, Connection Limits (`#71`, `#29`, `#84`)** | Inside **Settings → Sources & Playlists** (also 1-click reachable from **Profiles**) | Maintenance/setup flow, never daily watching chrome. |
| **Language, Theme Presets, High Contrast AAA, Text Scale, Playback/AFR, Parental PIN, Open-Source Notices (`#17`, `#325`, `#58`, `#98`)** | Categorized inside **Settings** (`Appearance & Theme`, `Playback & Audio`, `Sources & Playlists`, `Privacy & Licenses`) | 2-column sidebar + detail on Landscape; horizontal pill-tabs + grouped list on Portrait. |

---

## 3. Adaptive Form-Factor & Input Modality Rules

Layout forks happen strictly in container components via `useFormFactor()` along **Orientation (`Portrait` vs. `Landscape`)** and **Input Modality (`10-ft D-Pad` vs. `Pointer` vs. `Touch`)** — never by file suffix.

| Dimension | Landscape (`TV`, `PC`, `Tablet-L`, `Phone-L`) | Portrait (`Phone-P`, `Tablet-P`) |
| :--- | :--- | :--- |
| **Navigation Chrome** | Single transparent top bar (`56px`; frosted glass `blur(20px)` + `1px` bottom hairline after scroll). Left: `ELV IPTV` + 4 text links with `2px` accent active underline. Right: Search + Profile avatar. | Compact top bar (`50px`): `ELV IPTV` left, Search + Profile avatar right. Bottom fixed frosted tab bar (`58px`): exact same 4 destinations (`Home`, `Live TV`, `Movies`, `Series`). |
| **Horizontal Catalog Rails** | `5.5` columns visible (`0.5` peek on right edge communicates scrollability; scrollbars hidden). | `3.5` columns visible (`0.5` peek on right edge). |
| **Wide Rails (Continue Watching / Live)** | `3.3` columns visible (`16:9` aspect). | `1.2` columns on Phone-P (`2.3` on Tablet-P) so channel names & live badges remain single-line and readable. |
| **Full Category Grids (`See all`)** | `5` columns (`Math.floor(5.5)`). | `3` columns (`Math.floor(3.5)`). |
| **Detail Screen Order & Hero** | 2-column hero bottom (`230px` left actions + `1fr` right synopsis/meta). Vertical section order below Hero: **Cast** → **Season Dropdown & Episodes** (for series) → **More Like This**. | Single-column hero bottom (actions first, synopsis below), preserving the exact **Cast → Season Dropdown & Episodes → More Like This** order. |
| **Player Settings & Zap Drawer** | Right-anchored floating popover (`300px`, `top: 60px`); Live TV Mini-Guide anchored left (`306px`, below top controls with `.live-scrim-offset` preventing overlap). | Slide-up **Bottom Sheet** (`10px` inset, top grab handle). Bottom seekbar fades out while sheet is open; live subtitle preview shifts to upper viewport (`top: 24%`) so styling updates stay unobstructed. |
| **Player Top-Right Icons** | `Subtitles`, `Audio`, `Speed`, (`Lock` on tablet), `⋮ Settings`. | Compact 3-icon cap (`Subtitles`, `Lock`, `⋮ Settings`; Audio & Speed live 1 tap inside `⋮`) so title text never wraps or collides. |
| **Focus & Hover Grammar** | **TV (10-ft):** Crisp `2.5px` `--focus-ring-color` (`#FFFFFF`, `#FACC15` in AAA) + `1.05x` scale on cards/tiles (`1.04x` on buttons) + `5%` overscan safe zone. **PC:** Subtle artwork zoom (`1.04–1.05x`) + quiet `1.5px` highlight border on cards; fill shift on buttons. | **Touch:** Tactile press feedback (`scale(0.98)`), minimum `40×40px` touch targets, zero hover-dependent controls. |

---

## 4. Dynamic Token, Color & Geometry Contract

All colors, surfaces, scrims, and focus rings in `@elv/ui-kit` MUST be driven by a live theme token provider so users can switch palettes dynamically from day one (including WCAG AAA High Contrast `#325`).

### 4.1 Semantic Color Roles
- `--bg-canvas`: Deep neutral OLED darkness (`#090A0E` default, `#000000` in High Contrast AAA).
- `--bg-surface` / `--bg-card` / `--bg-elevated`: Quiet `+4%` tonal steps for inputs, channel cards, and popovers.
- `--cta-bg` / `--cta-fg`: Always neutral high-contrast (`#FFFFFF` / `#09090B`) for primary CTAs (`Play`, `Resume`, `Add & Sync`, active filter chip, active radio item).
- `--accent` / `--accent-contrast`: Reserved strictly for high-signal brand/state indicators — watch progress bars, seekbar fill, active nav underline, toggle switches, active channel row tint, and brand mark.
- `--live-color` / `--success-color`: Semantic broadcast red (`#EF4444`) with quiet `2s` pulse dot on live badges; green (`#22C55E`) for ratings & safe-connection indicators.
- **Built-in Theme Presets:** `Obsidian Crimson` (default), `Abyssal Sapphire`, `Theater Amber`, `Velvet Violet`, `Pitch Emerald`, and `High Contrast (AAA)`.

### 4.2 Locked Geometry & Typography
- `--radius-button: 4px` · `--radius-card: 6px` · `--radius-modal: 12px` · `--radius-pill: 999px` · `--grid-gap: 6px`
- **Typography:** `'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`; `tabular-nums` mandatory on timestamps, durations, channel numbers, ratings, and EPG grids. Monospace is restricted exclusively to the opt-in `Stats` HUD and source hostnames.
- **Copy:** Sentence case, active verbs, max ~65–75ch synopsis width, constructive empty/error states with a clear next action.

---

## 5. Motion & Micro-Interaction Grammar

- **Unified Easing Curve:** `cubic-bezier(0.22, 1, 0.36, 1)` (fast deceleration, zero cartoonish bounce).
- **Durations:** `150ms` (hover, focus ring, toggle, scrub thumb) · `200–240ms` (sticky frosted navbar, popover reveal, submenu drill-down, toast) · `280ms` (portrait bottom sheet rise, Live TV mini-guide slide).
- **Intentionality & Accessibility:** Animate only in response to user actions; never animate static grids on load. Respect `prefers-reduced-motion` (`#325`) globally.

---

## 6. Agent Pre-Merge UI Checklist

Before marking any UI PR ready, confirm all 10 items:
1. Primary navigation follows the active IA in §2.1 (default 4 destinations + 2 utilities) via config-driven `NavDestination[]` / `NavUtility[]` — never hardcoded slot counts.
2. Works cleanly in both **Portrait** (bottom tabs, bottom sheet, compact player top bar) and **Landscape** (top bar, right popover, 2-column detail).
3. Every focusable element is reachable via 10-ft TV D-pad with a crisp visible focus ring and zero clipping inside horizontal strips.
4. Zero hardcoded hex colors or dark-blue scrims — verified under both default and `High Contrast (AAA)` themes.
5. Zero anti-patterns: no boxed poster cards, no duplicate titles, no ALL-CAPS eyebrows, no neon outlines on white Play buttons.
6. Transparent-to-frosted top bar leaves safe clearance for non-hero screens and Live TV drawers/controls.
7. New playback controls live inside the 2-level `⋮ Settings` popover (never adding extra button rows over video).
8. Detail screen preserves **Hero → Cast → Season Dropdown & Episodes → More Like This**.
9. 100% of user-facing strings go through `@elv/i18n` (`TR` + `EN`), with zero forbidden copy or third-party brand names.
10. Empty, loading, offline, and `prefers-reduced-motion` states degrade gracefully.

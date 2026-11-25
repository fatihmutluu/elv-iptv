# ELV IPTV — UI/UX Design Philosophy & Feature Placement Rulebook

> **Scope:** Binding UI/UX contract (**Cinema Quietude v2**) for all current and future screens and features across **Android TV, Fire OS, tvOS, Android Phone/Tablet, iOS/iPadOS, Windows, macOS, and Linux**.
> **Rule for Every Implementing Agent:** Whenever you build a new screen, component, or user-facing feature in `@elv/ui-kit`, `@elv/features`, `apps/tv-mobile`, or `apps/desktop`, you MUST follow this philosophy and place the feature according to Section 2. Never invent ad-hoc tabs, boxed card styles, pill-bubble category bars, oversized hero clearances on non-overlay screens, hardcoded dark colors, or extra player chrome.

---

## 1. Core Identity — "Cinema Quietude"

An IPTV player is **not** a SaaS admin dashboard, a glowing gadget, or a cluttered legacy set-top box. It is a **dark screening room**. The interface exists to recede behind cinema artwork, live broadcasts, and crisp typography, surfacing controls only at the moment of user intent.

### Core Design Pillars
- **Extreme visual restraint:** Pure-artwork poster cards with zero wrapper boxes or duplicate titles; sharp `4px` primary CTAs in neutral high-contrast white (`#FFFFFF` on `#09090B`); full-bleed Hero spotlight (`~60–64%` viewport height: `360–580px` desktop/TV, `360–460px` phone portrait, matched consistently between `Home` and `Detail`) dissolving seamlessly into `--bg-canvas` so artwork breathes while the first content rail still invites scroll, anchored by horizontally centered full-width pagination dots on Home, a compact `Featured · Movie` status indicator, and restrained typography.
- **Pointer ergonomics — Safe-Hover Aim Triangles & Universal Tooltips:** Every hover-triggered floating panel or slider (such as the player volume popover and card action overlays) MUST protect diagonal pointer travel from trigger to panel using a **Safe-Hover Aim Triangle** corridor (`useSafeHoverBridge` / `computeSafeAimTriangle` + brief close-grace delay + active-drag lock) and MUST never lose hover when moving onto nested interactive child buttons (`react-native-web` hover-lock safe). Every interactive icon button and menu action on pointer/desktop surfaces MUST expose a concise, theme-tokenized **hover Tooltip** (`Tooltip`, ~320ms delay, edge-clamped, zero interference on TV/touch) explaining what the button does.
- **Overlay vs. non-overlay top clearance:** On Hero screens (`Home`, `Detail`), top navigation overlays artwork with a top-down gradient (no bottom border at scroll `0`) and transitions smoothly into frosted glass (`backdrop-filter: blur`) with a `1px` hairline border when scrolled. On **non-overlay screens** (`Live`, `Movies`, `Series`, `Search`, `Settings`), content renders directly below the in-flow top bar with tight `10–16px` top padding — never apply `heroTopClearance` (`74–82px+`) where no overlay Hero exists.
- **Proportional viewport card density:** Poster (`2:3`) and wide (`16:9`) card widths scale proportionally to viewport width and form factor with strict max-width caps (`<= 184px` posters, `<= 296px` wide cards on `1920px+` desktop monitors) so cards stay crisp and dense instead of bloating on wide displays.
- **Editorial category navigation & rail ergonomics:** Category strips use borderless **Editorial Underline Tabs (`EditorialCategoryBar`)** over a `1px` hairline divider (`2px` accent bottom indicator on active), paired with a compact `Categories ▾` dropdown popover when a catalog has many categories (`> 6`). Every horizontal rail and category strip (`HorizontalRailScroll`) supports touch swipe, mouse click-and-drag scrolling with drag-threshold click suppression, trackpad/`Shift+Wheel` horizontal pan (plus vertical-wheel horizontal pan on category strips), and hover-revealed left/right edge chevrons on desktop/pointer.
- **Clear aspect contrast:** Wide `16:9` cards are reserved exclusively for *Continue Watching* (on Home, Movies, and Series) and *Live Broadcasts*; vertical `2:3` posters drive *Catalog Discovery* (Movies, Series, My List, More Like This).
- **Favorites-first Live TV:** Entering `Live TV` presents unified **`Favorites | Channels | TV Guide`** sub-modes. `Favorites` surfaces only favorited live channels and plays the selected favorite channel live in the embedded background stage (with single-connection-safe handoff to fullscreen Player and zero Previous Channel / Number Pad clutter); `Channels` and `TV Guide` expose a 1-click favorite toggle (`star` / `starFilled`).
- **Flagship minimalist cinema player:** Transparent borderless OSD over soft top/bottom linear scrims with an unobstructed center video canvas (no giant center play button blocking playback): bare top-left `×` + bold Title/Subtitle, bare top-right icon strip (`Subtitles`, `Audio/Volume`, `Aspect`, `Fullscreen`, `1×` speed, `⋮` overflow settings), full-width thin interactive scrubber (`3px` resting -> `5px–6px` active/hover) flanked by left/right tabular timestamps (`Total` / `-Remaining` / `Ends at HH:MM`) with chapter dots and touch fine-scrubbing zoom, centered transport trio (`⟲10`, translucent glass circular `▶/‖`, `⟳10`) directly below the scrubber, sleek dark-glass bottom-right CTA pill (`Next Episode` / `Channels`), and a compact **2-level Settings popover** morphing into a slide-up bottom sheet on portrait devices. (Legacy child-HWND desktop fallback splits the identical minimalist top/bottom strips cleanly outside the video region.)
- **Zero-Blink & Instant Prewarm Everywhere:** Navigating between tabs (`Home`, `Live`, `Movies`, `Series`), switching categories, opening a series/movie detail screen, switching seasons, or returning from playback MUST feel instantaneous with **zero 1-frame empty flashes, header pop-ins, or skeleton blinks**. Preload predictable catalog metadata, category bars, initial slices, and adjacent series seasons into a bounded `catalogRevision`-keyed in-memory snapshot cache (`CatalogUiCache`) on startup and navigation, keep previously rendered data visible (`keepPreviousData` / stale-while-revalidate) while background refreshes settle, and invalidate strictly on catalog/source mutation or locale change.

### Strictly Forbidden Anti-Patterns
1. **Boxed poster cards:** Never wrap poster art + title inside a colored card container with borders. Posters are rounded artwork (`6px`) with minimal title/year/rating cleanly below.
2. **Duplicate titles:** Never print title/genre text over the poster image AND repeat the title underneath.
3. **ALL-CAPS eyebrow clutter:** Do not stamp tracked ALL-CAPS eyebrow labels above every heading. Use sentence case and quiet structural indicators (a `3px` accent bar or compact outlined micro-pills like `4K HDR`, `16+`).
4. **Uniform neon hover/focus outlines:** Never put a bright colored outline around a white Play button on desktop hover. Focus and hover treatments must be surface-aware.
5. **Hardcoded dark-blue scrims:** Every scrim and glass panel MUST derive dynamically from `var(--bg-canvas)` / `var(--bg-elevated)` so switching themes transforms the entire app coherently.
6. **Hardcoded or mixed-language copy:** 100% of user-facing strings route through `@elv/i18n` (Lingui) with complete `TR` and `EN` parity, zero third-party competitor brand names, and zero prohibited copy.
7. **Pill-bubble category chips:** Never render rounded `999px` pill-capsule buttons (`FilterChip`) for category navigation across Live, Movies, Series, and Search. Category bars MUST use borderless **`EditorialCategoryBar`** underline tabs over a `1px` hairline divider (`2px` accent active bar), paired with a `Categories ▾` dropdown popover when categories exceed `6`.

---

## 2. Information Architecture — "Where Does a New Feature Go?"

### 2.1 Default Top-Level Architecture: 4 + 2 (Config-Driven & Extensible)
Our **recommended default** top-level navigation is **4 primary destinations** + **2 utility endpoints** (`EPG`, `Favorites`, and `Sources` stay tucked inside their natural homes to preserve Cinema Quietude).

> **Modularity Rule:** Navigation components (`AdaptiveNavShell`, top bar, bottom tab bar) MUST be **100% data-driven** (`destinations: readonly NavDestination[]`, `utilities: readonly NavUtility[]`) — never hardcode a fixed 4-slot layout or magic tab indices in code. Adding, removing, or reordering a destination must be a clean configuration change, and intentional IA evolutions should update this living document alongside the change.

| Slot | Destination | Owns |
| :--- | :--- | :--- |
| **1. Home** | `home` | Proportional Hero spotlight carousel (`~60–64%` viewport height, compact `Featured · Movie` indicator, first rail peeking above the fold), *Continue Watching* (`16:9` wide rail), *On Air Now* (live broadcast rail + link to `TV Guide`), *My List* (dynamic favorites rail), *Featured Movies*, *Featured Series*. |
| **2. Live TV** | `live-player` | Unified Live Mode Switcher (**`Favorites \| Channels \| TV Guide`**). `Favorites` shows ONLY favorited live channels and plays the selected favorite channel live in the embedded background stage (single-connection-safe handoff to fullscreen Player; NO Previous Channel or Number Pad clutter). `Channels` & `TV Guide` provide 1-click favorite toggles, `EditorialCategoryBar` category browsing, and channel jump tools (`0–9` Number Pad / Mini-Guide / Previous Channel). |
| **3. Movies** | `movies` | Top `16:9` **`Continue watching`** horizontal rail (in-progress movies), followed immediately by **`EditorialCategoryBar`** (with `Categories ▾` popover when `> 6` categories; zero `All \| Unwatched \| In progress \| Watched` pill chips) and proportional `2:3` category peek rails, each with `See all ›` drilling into a full vertical `category-grid`. |
| **4. Series** | `series` | Identical structural grammar to Movies: top `16:9` **`Continue watching`** horizontal rail (in-progress series), followed immediately by **`EditorialCategoryBar`** (`Categories ▾` popover when `> 6`) + proportional `2:3` category peek rails + `See all ›` full `category-grid` (zero watch-status pill chips). |
| **Utility 1 (Right)** | `search` | Instant Turkish-tolerant search across Live Channels, Movies, and Series + editorial underline scope tabs (`All`, `Live`, `Movies`, `Series`) + recent searches + constructive empty state (zero pill-bubble category chips). |
| **Utility 2 (Right)** | `settings` | Settings hub (`Appearance`, `Sources`, `About & Licenses`), evolving cleanly into a Profile avatar opening the Profile Picker with secondary entry points to **Settings** and **Sources** once local profiles land. |

### 2.2 Feature Placement Decision Matrix
Before designing or coding any feature, locate its exact home here:

| Feature / Roadmap Area | Exact Placement | Design Rationale |
| :--- | :--- | :--- |
| **Live Favorites Stage (`#14`, `#48`)** | **`Favorites`** sub-mode inside **Live TV** (`Favorites \| Channels \| TV Guide`) | Dedicated live playback stage showing only starred channels with single-connection-safe fullscreen handoff and zero keypad/prev-channel clutter. |
| **XMLTV EPG Grid & PiP Preview (`#6`, `#49`)** | **`TV Guide`** sub-mode inside **Live TV** (`Favorites \| Channels \| TV Guide`) + quick link from Home's *On Air Now* header | EPG is a live-broadcast scheduling lens with 1-click channel favorite toggles; keeps top nav permanently at 4 items. |
| **Channel Grid / Category Browse (`#13`)** | **`Channels`** sub-mode inside **Live TV** + **`EditorialCategoryBar`** + 1-click favorite toggle | Same live-TV family; clean underline category browsing and instant starring into `Favorites`. |
| **Number Jump (`#44`), Prev Channel (`#43`), Mini-Guide (`#48`)** | Top/left overlay controls inside **Live TV `Channels`/Player** + hardware remote shortcuts (`0–9`, `M`, `P`) — omitted from `Favorites` stage | Living-room muscle memory where browsing/zapping happens, keeping `Favorites` clean and distraction-free. |
| **Movies & Series Continue Watching (`#14`)** | Dedicated `16:9` **`Continue watching`** horizontal rail directly at the top of **Movies** (movies) and **Series** (series), plus **Home** | Surfaces active resumes immediately above editorial category rails without redundant watch-status pill filters. |
| **Category Navigation & Large Catalog Picker** | Borderless **`EditorialCategoryBar`** underline tabs + **`Categories ▾`** dropdown popover (`> 6` categories) | Eliminates pill-bubble clutter while allowing 1-click jumps across 50–200+ provider categories. |
| **Catch-Up (`#24`) & Live Time-Shift (`#25`)** | Inside **EPG** past slots (select past show → catch-up) & **Live TV** bottom scrub bar (when supported by source) | Contextual to the broadcast timeline; zero extra tabs. |
| **Program Reminders (`#35`)** | Action button in **EPG** preview header when a future program slot is selected | Only relevant when inspecting upcoming schedules. |
| **PiP / Multi-View (`#26`)** | Compact icon button in **Live TV / VOD Player** top-right utility cluster | Contextual playback mode, not a catalog destination. |
| **Subtitles, Audio, Speed (`0.5×–2×`), Aspect, A/V Sync, Dialogue Boost, Subtitle Styling, Stats (`#28`, `#51`, `#115`, `#351`)** | **2-Level Player Settings Popover** (`⋮` / quick `CC`, `Audio`, `Mute`, `Fullscreen` icons; morphs to Bottom Sheet on Portrait) | Keeps the video canvas clean while scaling smoothly to 8+ controls (including Playback Speed `0.5×–2×`) in 1–2 actions. |
| **Skip Intro (`#354`), Next Episode (`#353`)** | Floating high-contrast CTA anchored **bottom-right directly above the seekbar**, visible only during active intro/outro windows | Predictable spatial anchor; never competes with center transport. |
| **In-Player Cast & Scene Info (`#352`)** | Opt-in compact pill **bottom-left above the seekbar** expanding a single translucent horizontal cast strip on pause/click | Zero clutter during active playback; instant context when paused. |
| **Interactive Scrubber & Trickplay (`#355`, `#356`)** | Thin timeline bar (`3px` resting -> `6px` active/hover) with pointer drag-scrubbing, hover timecode preview, and inline `16:9` trickplay tooltip above thumb | Direct spatial manipulation anchored cleanly to the timeline (and HWND-safe flex Cinema Bar on Desktop). |
| **Mobile Touch Lock (`#115`)** | Lock icon in Player top-right (Phone/Tablet only); hides all OSD leaving a single centered `Unlock controls` pill | Prevents accidental palm touches without adding desktop/TV chrome. |
| **Favorites / My List (`#14`)** | Circular `+` / `✓` toggle on Hero & Detail → populates **My List** on **Home**; 1-click star toggle on Live `Channels`/`TV Guide` → populates **Live `Favorites`** | Removes the need for a separate top-level Favorites tab. |
| **Sources (M3U / Xtream / Stalker), Sync, Connection Limits (`#71`, `#29`, `#84`)** | Inside **Settings → Sources** | Maintenance/setup flow, never daily watching chrome. |
| **Language, Theme Presets, High Contrast AAA, Text Scale, Playback/AFR, Parental PIN, Open-Source Notices (`#17`, `#325`, `#58`, `#98`)** | Categorized inside **Settings** (`Appearance`, `Sources`, `About & Licenses`) | 2-column sidebar + detail on Landscape; horizontal tabs + grouped list on Portrait. |

---

## 3. Adaptive Form-Factor & Input Modality Rules

Layout forks happen strictly in container components via `useFormFactor()` / `useViewport()` along **Orientation (`Portrait` vs. `Landscape`)** and **Input Modality (`10-ft D-Pad` vs. `Pointer` vs. `Touch`)** — never by file suffix.

### 3.1 Proportional Viewport Card Density & Max-Width Caps
Static landscape column counts (`5.5 / 3.3 / 5`) are replaced by responsive viewport-aware density so posters and wide cards remain crisp across phones, tablets, TVs, and ultra-wide monitors:

| Target Viewport | Grid (`2:3` Cols) | Poster Rail (`2:3` Cols) | Wide Rail (`16:9` Cols) | Notes & Max-Width Caps |
| :--- | :--- | :--- | :--- | :--- |
| **Desktop / Web (`1280px`)** | `7` | `7.4` (`~158px`) | `4.5` (`~258px`) | Baseline desktop density. |
| **Desktop / Web (`1440px`)** | `8` | `8.4` | `5.3` | Standard laptop / 1440p monitor. |
| **Desktop / Web (`1920px+`)** | `9–10` (up to `11`) | `10.4` (up to `11.4`) | `6.3` (up to `7.3`) | Strict caps: posters **`<= 184px`**, wide cards **`<= 296px`** (zero wide-monitor bloat). |
| **TV (`1280×720` logical)** | `6` | `6.4` | `4.3` | Scaled inside `5%` overscan safe zone. |
| **TV (`1920×1080` logical)** | `7` | `7.4` | `5.3` | Full-HD 10-foot living-room density. |
| **Tablet Landscape (`1194×834`)** | `6` | `6.5` | `4.2` | Generous touch/pointer peek. |
| **Tablet Portrait (`834×1194`)** | `5` | `5.3` | `2.6` | Balanced portrait density. |
| **Phone Portrait (`393×852`)** | `3` | `3.25` | `1.35` | Single-line readable titles & live badges on wide cards. |
| **Phone Landscape (`852×393`)** | `5` | `5.5` | `3.2` | Compact horizontal peek. |

*(Narrow Desktop windows `< 1280px` step down proportionally to `6 / 6.4 / 4.2` under `1280px`, `5 / 5.3 / 3.3` under `1024px`, and `3 / 3.5 / 2.2` under `760px`.)*

### 3.2 Structural Chrome, Hero Clearance, Rail Ergonomics & Player OSD

| Dimension | Landscape (`TV`, `PC`, `Tablet-L`, `Phone-L`) | Portrait (`Phone-P`, `Tablet-P`) |
| :--- | :--- | :--- |
| **Navigation Chrome** | Single top bar (`56px`, `58px` TV; transparent gradient over Hero, frosted glass `blur(20px)` + `1px` bottom hairline on scroll or non-overlay pages). Left: `ELV IPTV` + config-driven text links (`2px` accent active underline). Right: Search + Settings. | Compact top bar (`50px`): `ELV IPTV` left, Search + Settings right. Bottom fixed frosted tab bar (`58px`): exact same primary destinations. |
| **Hero Fold & Top Clearance** | **Hero screens (`Home`, `Detail`):** Hero Spotlight targets `~60–64%` viewport height (`360–580px` desktop/TV, matched identically across `Home` and `Detail`) with `heroTopClearance` and full-width centered carousel dots on Home. **Non-overlay screens (`Live`, `Movies`, `Series`, `Search`, `Settings`):** render below the in-flow top bar with tight `10–16px` top padding (`heroTopClearance` FORBIDDEN). | **Hero screens (`Home`, `Detail`):** Phone portrait Hero targets `56%` viewport height (`360–460px`, matched across `Home` and `Detail`) with centered carousel dots on Home. **Non-overlay screens:** tight `10–16px` top padding below top bar (`heroTopClearance` FORBIDDEN). |
| **Category Navigation** | Borderless **`EditorialCategoryBar`** underline tabs over a `1px` hairline divider (`2px` accent bottom indicator on active); compact `Categories ▾` dropdown popover when categories `> 6`. Zero `999px` pill-bubble category chips. | Same borderless **`EditorialCategoryBar`** underline tabs + `Categories ▾` dropdown popover when categories `> 6`. Minimum `40px` vertical touch height. |
| **Horizontal Rails & Strips (`HorizontalRailScroll`)** | Pointer click-and-drag scrolling with `>= 5px` drag-threshold click suppression, trackpad/`Shift+Wheel` horizontal scroll (plus direct vertical-wheel horizontal pan on thin category strips, releasing smoothly at boundaries), and hover-revealed left/right edge chevrons (`chevronLeft` / `chevronRight`). TV auto-scrolls smoothly on focus. | Touch swipe with smooth deceleration and zero clipped focus/scroll bounds. |
| **Detail Screen Order & Hero** | 2-column hero bottom (`230px` left actions + `1fr` right synopsis/meta). Vertical section order below Hero: **Cast** → **Season Dropdown & Episodes** (for series) → **More Like This**. | Single-column hero bottom (actions first, synopsis below), preserving the exact **Cast → Season Dropdown & Episodes → More Like This** order. |
| **Player OSD & Settings** | **Floating Minimalist Cinema Overlay** (TV, Tablet-L, Phone-L, and Desktop in-canvas): transparent soft top/bottom scrims with open center video; top bar (`×` + Title/Subtitle left, bare icon strip `Subtitles`, `Audio/Volume`, `Aspect`, `Fullscreen`, `1×`, `⋮` right); full-width hairline scrubber with split left/right tabular timestamps & chapter dots; centered transport trio (`⟲10`, translucent glass circular `▶/‖`, `⟳10`) beneath scrubber; dark-glass bottom-right CTA pill (`Next Episode` / `Channels`); right-anchored 2-level `⋮ Settings` popover. *(Legacy child-HWND fallback docks the identical top/bottom strips outside the video stage without overlap.)* | Identical minimalist transparent overlay with compact 3-icon top-right cap (`Subtitles`, `Lock`, `⋮ Settings`), touch fine-scrubbing zoom timeline (`1× / 0.25× / 0.1×`), and slide-up **Bottom Sheet** (`10px` inset, top grab handle) hosting Audio, Subtitles, Speed, Aspect, Sleep Timer, and Stats. |
| **Focus & Hover Grammar** | **TV (10-ft):** Crisp `2.5px` `--focus-ring-color` (`#FFFFFF`, `#FACC15` in AAA) + `1.05x` scale on cards/tiles (`1.04x` on buttons) + `5%` overscan safe zone. **PC:** Subtle artwork zoom (`1.04–1.05x`) + quiet `1.5px` highlight border on cards; fill shift on buttons. | **Touch:** Tactile press feedback (`scale(0.98)`), minimum `40×40px` touch targets, zero hover-dependent controls. |

---

## 4. Dynamic Token, Color & Geometry Contract

All colors, surfaces, scrims, and focus rings in `@elv/ui-kit` MUST be driven by a live theme token provider so users can switch palettes dynamically from day one (including WCAG AAA High Contrast `#325`).

### 4.1 Semantic Color Roles
- `--bg-canvas`: Deep neutral OLED darkness (`#090A0E` default, `#000000` in High Contrast AAA).
- `--bg-surface` / `--bg-card` / `--bg-elevated`: Quiet `+4%` tonal steps for inputs, channel cards, and popovers.
- `--cta-bg` / `--cta-fg`: Always neutral high-contrast (`#FFFFFF` / `#09090B`) for primary CTAs (`Play`, `Resume`, `Add & Sync`, active radio item).
- `--accent` / `--accent-contrast`: Reserved strictly for high-signal brand/state indicators — watch progress bars, seekbar fill, active nav underline, active category underline indicator, toggle switches, active channel row tint, and brand mark.
- `--live-color` / `--success-color`: Semantic broadcast red (`#EF4444`) with quiet `2s` pulse dot on live badges; green (`#22C55E`) for ratings & safe-connection indicators.
- **Built-in Theme Presets:** `Obsidian Crimson` (default), `Abyssal Sapphire`, `Theater Amber`, `Velvet Violet`, `Pitch Emerald`, and `High Contrast (AAA)`.

### 4.2 Locked Geometry & Typography
- `--radius-button: 4px` · `--radius-card: 6px` · `--radius-modal: 12px` · `--radius-pill: 999px` (reserved for compact status micro-pills and circular icon buttons, NEVER category bars) · `--grid-gap: 6px`
- **Typography:** `'Plus Jakarta Sans', 'Inter', system-ui, sans-serif`; `tabular-nums` mandatory on timestamps, durations, channel numbers, ratings, speed badges, and EPG grids. Monospace is restricted exclusively to the opt-in `Stats` HUD and source hostnames.
- **Copy:** Sentence case, active verbs, max ~65–75ch synopsis width, constructive empty/error states with a clear next action.

---

## 5. Motion & Micro-Interaction Grammar

- **Unified Easing Curve:** `cubic-bezier(0.22, 1, 0.36, 1)` (fast deceleration, zero cartoonish bounce).
- **Durations:** `150ms` (hover, focus ring, toggle, scrubber `3px -> 6px` active expansion, hover edge-chevron reveal) · `200–240ms` (sticky frosted navbar, category underline transition, `Categories ▾` & player popovers, submenu drill-down, toast) · `280ms` (portrait bottom sheet rise, Live TV mini-guide slide).
- **Direct Manipulation & Drag Scroll:** Click-and-drag rail panning tracks pointer movement `1:1` with zero spring lag and suppresses synthetic click activation after a `>= 5px` drag.
- **Intentionality & Accessibility:** Animate only in response to user actions; never animate static grids on load. Respect `prefers-reduced-motion` (`#325`) globally.

---

## 6. Agent Pre-Merge UI Checklist

Before marking any UI PR ready, confirm all 11 items:
1. **IA, Live Favorites & Discovery (§2):** Config-driven `NavDestination[]` / `NavUtility[]` (`4+2` default); Live TV uses **`Favorites | Channels | TV Guide`** (no Number Pad / Previous Channel clutter in `Favorites`; 1-click favorite toggle in `Channels` & `TV Guide`); Movies & Series open with a `16:9` **`Continue watching`** rail and have zero watch-status pill chips.
2. **Proportional Card Density & Caps (§1 & §3):** Rails and grids follow viewport-proportional `useViewport().columns` (`7.4/8.4/10.4` desktop posters, `6.4/7.4` TV, `6.5/5.3` tablet, `3.25/5.5` phone) with strict max-width caps (`<= 184px` posters, `<= 296px` wide cards) — never bloated static `5.5 / 3.3 / 5` cards on wide monitors.
3. **Hero Fold & Non-Overlay Top Clearance (§1 & §3):** Hero targets `~60–64%` viewport height (`360–580px` desktop/TV, `360–460px` phone portrait, matched identically across `Home` and `Detail`) with full-width centered carousel dots on `Home`; non-overlay screens (`Live`, `Movies`, `Series`, `Search`, `Settings`) sit below the in-flow top bar with tight `10–16px` top padding and NEVER apply `heroTopClearance` (`74–82px+`).
4. **Zero Anti-Patterns & Editorial Category Tabs (§1):** Zero boxed poster cards, zero duplicate titles, zero ALL-CAPS eyebrows, zero neon outlines on white Play buttons, and **zero pill-bubble (`999px` `FilterChip`) category bars** — category bars use borderless **`EditorialCategoryBar`** underline tabs (plus `Categories ▾` popover when `> 6` categories).
5. **Horizontal Rail & Strip Ergonomics (§3 & §5):** Every horizontal rail and category strip supports touch swipe, mouse click-and-drag scrolling with drag-threshold click suppression (`HorizontalRailScroll`), trackpad/`Shift+Wheel` horizontal pan (plus vertical-wheel pan on category strips), and hover-revealed edge chevrons on desktop/pointer.
6. **Adaptive Portrait/Landscape & 10-ft TV Focus (§3):** Works cleanly in both Portrait and Landscape; every focusable element is reachable via 10-ft TV D-pad with a crisp visible focus ring and zero clipping inside horizontal strips.
7. **Flagship Minimalist Player OSD & Settings (§1, §2.2, §3):** Unobstructed center video canvas; bare borderless top bar (`×` + Title/Subtitle left, bare icon strip right); full-width thin hairline scrubber (`3px` -> `5px–6px` active/hover) with split left/right tabular timestamps (`Total`/`-Remaining`/`Ends at`), chapter dots, and touch fine-scrubbing; centered `⟲10` / translucent glass `▶/‖` / `⟳10` transport directly below scrubber; sleek dark-glass bottom-right `Next Episode` / `Channels` pill; and 2-level `⋮ Settings` popover / Portrait bottom sheet.
8. **Detail Screen Order (§3):** Preserves **Hero → Cast → Season Dropdown & Episodes → More Like This**.
9. **Dynamic Theme Tokens & Zero Hardcoded Hex (§4):** Zero hardcoded hex colors or dark-blue scrims — verified under both default and `High Contrast (AAA)` themes.
10. **i18n, Copy Hygiene & Resilience (§1, §4, §5):** 100% of user-facing strings route through `@elv/i18n` (`TR` + `EN`), zero third-party brand names or forbidden copy, and empty, loading, offline, and `prefers-reduced-motion` states degrade gracefully.
11. **Zero-Blink & Instant Prewarm (§1):** Tab switches, category filters, detail opens, season switches, and playback returns hydrate synchronously from bounded `catalogRevision`-keyed snapshots (`CatalogUiCache`) and retain previously rendered content (`keepPreviousData`) during background refreshes — zero 1-frame empty headers, missing category bars, or skeleton flashes.
12. **Safe-Hover Aim Triangles & Universal Tooltips (§1):** Every hover-triggered floating panel/slider protects diagonal cursor travel via a Safe-Hover Aim Triangle (`useSafeHoverBridge`) + drag lock, nested pointer hover actions never collapse on child entry, and every pointer-reachable icon button / menu control renders a theme-tokenized `Tooltip` explaining its action (zero interference on TV/touch).

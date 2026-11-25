# Wave P1 — UI/UX Philosophy v2.1, Safe-Hover Aim Triangles, Universal Tooltips & Critical UI Bug Fixes

**Date:** 2026-11-26  
**Branch:** `feat/wave-p1-ux-foundations-and-fixes`  
**Status:** Design Approved (Autonomous Maintainer Flow)

## 1. Goals & Scope
Fix four high-visibility daily-use UI bugs and establish two reusable Cinema Quietude v2 interaction primitives across Desktop, TV, and Mobile:
1. **Live Favorites Disappearing Bug:** Raise user-list IPC & repository ceiling from `100` to `250` (matching `MAX_LIVE_FAVORITES = 200`), prevent transient IPC failures from wiping hydrated `favoriteChannels` in `useLiveFavorites` / `CatalogUiCache`, and add regression tests across desktop IPC guards and `useLiveFavorites`.
2. **Poster Hover Star Vanishing Bug (`PosterCard.tsx`):** Fix `react-native-web` nested `<Pressable>` `useHover({ contain: true })` lock propagation so hovering from the poster onto its quick-action buttons (Play, Favorite Star, Watched) never collapses the hover overlay.
3. **Home Live Cards Double-Rounded Corner Artifact (`WideCard.tsx` & `ArtworkImage.tsx`):** Remove stacked nested `borderRadius` + translucent `subtleHighlight` plate bleed behind live card corners so every wide live card renders one crisp clipped rounded silhouette.
4. **Taller Matching Home & Detail Hero Banners + Centered 5 Pagination Dots:** Unify hero height computation (`computeHeroHeight`) at a richer cinematic proportion (`~60–64%` viewport height, `360–580px` desktop/TV, `360–460px` portrait) across both `HomeHero` and `DetailHero`, and center `HomeHero`'s 5 pagination dots horizontally across the full hero width instead of inside the left-aligned `maxWidth: 680` text block.
5. **Safe-Hover Aim Triangle (`@elv/ui-kit`):** Implement an Amazon-style pointer aim-triangle (`pointInTriangle` + grace close delay + drag lock) primitive (`createSafeHoverController` / `useSafeHoverBridge`) so moving the pointer from a trigger button toward its floating panel never prematurely closes the panel. Apply directly to the Player Volume button -> `OsdVolumeSlider` (eliminating the `6px` vertical gap and mid-drag unmount) and audit `MultiViewTileCard` / hover overlays.
6. **Universal Hover Tooltips (`@elv/ui-kit` `Tooltip`) & UI Philosophy v2.1:** Add a lightweight, pointer-only, accessible, edge-clamped `Tooltip` component styled strictly with Cinema Quietude v2 theme tokens (`bgElevated`, `surfaceBorder`, `textPrimary`, `prefers-reduced-motion` aware, no-op on TV/touch). Wire tooltips onto icon/action buttons across `IconButton`, `OsdButton`, `AdaptiveNavShell` / `NavBars`, `HomeHero`, `DetailHero`, `PosterCard` quick actions, `FloatingMiniPlayerChrome`, `MultiViewTileCard`, and `PlayerSettingsSheet`. Document Safe-Hover Aim Triangles, Universal Tooltips, Hero Heights, and Centered Hero Dots in `docs/design/UI_UX_PHILOSOPHY.md`.

## 2. Technical Design

### 2.1 Live Favorites Persistence & IPC Ceiling
- `apps/desktop/src/shared/catalog-ipc-guards.ts`: raise `MAX_USER_LIST_LIMIT` from `100` to `250`.
- `packages/data/src/user-state-helpers.ts`: raise `MAX_LIST_LIMIT` from `100` to `250`.
- `packages/features/src/live/useLiveFavorites.ts`: distinguish an IPC/query rejection from an empty result (do not overwrite hydrated `favoriteChannels` / `CatalogUiCache` with `[]` if `listFavorites` throws!).
- `packages/features/src/shell/useCatalogPrewarm.ts`: keep `MAX_LIVE_FAVORITES = 200` safely within `MAX_USER_LIST_LIMIT = 250`.

### 2.2 PosterCard Nested Hover Fix
- In `packages/ui-kit/src/primitives/PosterCard.tsx`, `react-native-web`'s `Pressable` runs `useHover({ contain: true })`, causing nested child `<Pressable>` quick-actions to emit `'react-gui:hover:lock'` and force the parent `Pressable` to fire `onHoverOut`.
- Fix: Wrap the outer card container in a pointer-tracking `<View>` (attaching web `onPointerEnter` / `onPointerLeave` — which track real DOM element subtree entry/exit without bubbling hover-lock cancellation from child `<Pressable>`s — alongside `onHoverIn` fallback for test environments) while keeping the inner `<Pressable>` strictly for press/focus/TV D-pad interactions. Add unit test verifying moving focus/hover to `quick-favorite` does NOT unmount the overlay.

### 2.3 Home Live Card Single Clipped Surface
- In `packages/ui-kit/src/primitives/WideCard.tsx` and `ArtworkImage.tsx`:
  - When `WideCard` renders `artworkShadow` (`bgCard`) -> `artworkClip` (`overflow: 'hidden', borderRadius: card`) -> `ArtworkImage` (`logoBackdrop=true`), `ArtworkImage` applies `subtleHighlight` (`rgba(textPrimary, 0.07)`) on its outer `styles.frame` with its own `borderRadius`, AND inside it renders opaque `styles.fallback` (`bgCard`) or `Scrim` (`bgCanvas`) which anti-aliases slightly inside the outer rounded clip, exposing a pale second rounded halo around the corners.
  - Fix: Keep `borderRadius` clipping strictly on `WideCard`'s outer `artworkClip` (pass `borderRadius={0}` to `ArtworkImage` inside an already-clipped container, and keep `artworkShadow` background transparent or matched to the active plate color only when logo artwork actually loads, never stacking two distinct rounded backgrounds at identical radii).

### 2.4 Unified Taller Hero Height & Centered Pagination Dots
- Add `computeHeroHeight(viewportHeight: number, isPortrait: boolean, isTv: boolean, isDesktop: boolean): number` (shared in `packages/features/src/shared/` or exported from `HomeSkeleton.tsx` / `hero-layout.ts`):
  - Landscape (Desktop / TV / Tablet-L): `Math.min(580, Math.max(360, Math.round(viewportHeight * 0.62)))`
  - Portrait (Phone / Tablet-P): `Math.min(460, Math.max(360, Math.round(viewportHeight * 0.56)))`
- Apply `computeHeroHeight` to both `HomeHero` (`HomeSkeleton.tsx`) and `DetailHero` (`DetailHero.tsx`) so Home and Detail hero heights match proportionally across all viewports.
- In `HomeHero.tsx`: move `dotsRow` out of the `maxWidth: 680` `content` wrapper into a full-width centered footer row (`width: '100%', alignItems: 'center', justifyContent: 'center'`) at the bottom of the hero container so the 5 dots sit dead-center on every screen width.

### 2.5 Safe-Hover Aim Triangle (`@elv/ui-kit`)
- Pure geometry module `packages/ui-kit/src/primitives/safe-hover-geometry.ts` (100% unit-tested):
  - `isPointInTriangle(pt, a, b, c)` (barycentric / cross-product half-plane test with inclusive boundary epsilon).
  - `computeSafeAimTriangle(origin, targetRect, marginPx)`: builds the safe aim corridor triangle from the pointer's last exit point `origin` to the two furthest visible corners of `targetRect` (expanded by `marginPx`, default `12px`), automatically handling all 4 popover directions (below, above, left, right).
- Stateful controller + React hook `packages/ui-kit/src/primitives/useSafeHoverBridge.ts`:
  - Tracks `open` state, `dragging` lock (`setLocked(true)` prevents close while dragging a slider even if pointer exits the popover!), last pointer coordinates, trigger ref, and panel ref.
  - On trigger leave: if `locked`, stay open; else check if pointer movement stays inside the safe aim triangle toward `panelRect` (up to `aimGraceMs = 300ms`) or falls within a short `closeDelayMs = 140ms` bridge grace window; cancel close immediately on panel enter.
  - Zero-overhead no-op on non-web / touch / TV platforms.
- Wire into `PlayerOsdTopBar.tsx` (`player-volume-control` -> `player-volume-popover` + `OsdVolumeSlider` `onDragStateChange` lock + eliminate dead gap with transparent hit-bridge padding).

### 2.6 Universal `Tooltip` Primitive (`@elv/ui-kit`)
- `packages/ui-kit/src/primitives/Tooltip.tsx`:
  - Props: `content?: string`, `description?: string`, `placement?: 'top' | 'bottom' | 'left' | 'right'`, `delayMs?: number` (default `320`), `disabled?: boolean`, `children`.
  - Pure pointer-only behavior (`Platform.OS === 'web'` and `!isTv`; renders `children` untouched on TV/touch so zero focus or touch regressions).
  - Theme-token dark-glass surface (`theme.colors.bgElevated`, `theme.colors.surfaceBorder`, `theme.colors.textPrimary`, `theme.colors.textSecondary` for optional secondary description), `pointerEvents: 'none'`, subtle `150ms` opacity/translate transition (instant when `reduceMotion` is on), and viewport edge clamping so tooltips near top-right/bottom-right never clip off-screen.
- Wire cleanly into:
  - `IconButton` (optional `tooltip?: string`, defaults to `accessibilityLabel` when pointer-hovered unless `tooltip={false}`)
  - `OsdButton` (`PlayerOsdButton.tsx` — shows `p.label` tooltip on pointer hover!)
  - `NavBars.tsx` (`UtilitiesRow` search/settings/profile buttons), `HomeHero.tsx` circular buttons, `DetailHero.tsx` circular buttons, `PosterCard.tsx` quick actions, `FloatingMiniPlayerChrome.tsx` buttons, `MultiViewTileCard.tsx` buttons.

## 3. Verification Plan
- Pure unit tests for `safe-hover-geometry.ts` (all 4 directions, boundary edges, degenerate rects, moving toward vs away from panel).
- Unit tests for `useSafeHoverBridge` (triangle corridor keeps open, moving away closes after grace, drag lock prevents mid-drag close, timer cleanup on unmount).
- Unit tests for `Tooltip` (delay reveal, hide on leave/press, disabled on TV, empty content no-op, theme tokens only).
- Regression tests for `PosterCard` nested hover, `WideCard` live single-surface clipping, `HomeHero` centered dots & taller hero height, `DetailHero` matching height, `PlayerOsdTopBar` volume safe hover + drag lock, `useLiveFavorites` limit 200 & non-wiping error handling, `catalog-ipc-guards` limit 250.
- Full `pnpm check` (`0 failed`) + independent `Neon High` review before PR merge.

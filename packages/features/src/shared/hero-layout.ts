/**
 * Computes the unified Cinema Quietude v2.1 Hero Spotlight height for both Home and Detail screens.
 *
 * - Landscape (Desktop / TV / Tablet-L): `Math.min(580, Math.max(360, Math.round(safeHeight * 0.62)))`
 * - Portrait (Phone / Tablet-P): `Math.min(460, Math.max(360, Math.round(safeHeight * 0.56)))`
 */
export function computeHeroHeight(
  viewportHeight: number,
  isPortrait: boolean,
  _isTv: boolean,
  _isDesktop: boolean,
): number {
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720;
  return isPortrait
    ? Math.min(460, Math.max(360, Math.round(safeHeight * 0.56)))
    : Math.min(580, Math.max(360, Math.round(safeHeight * 0.62)));
}

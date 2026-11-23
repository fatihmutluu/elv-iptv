import type { TvClockMode } from '@elv/domain';

/** Surface where `AmbientTvClock` is mounted (`#416`). */
export type AmbientClockSurface = 'menus' | 'player';

/** Returns whether the ambient TV clock should render for the given preference mode and surface (`#416`). */
export function shouldShowAmbientClock(mode: TvClockMode, surface: AmbientClockSurface): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return mode === surface;
}

/** Computes milliseconds until the next local minute boundary (+50 ms guard against early firing). */
export function msUntilNextMinuteBoundary(nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 60_050;
  const rem = ((nowMs % 60_000) + 60_000) % 60_000;
  return 60_000 - rem + 50;
}

/** Formats local wall-clock time via `Intl.DateTimeFormat` with `{ timeStyle: 'short' }` and safe fallback. */
export function formatAmbientClockTime(nowMs: number, locale: string): string {
  if (!Number.isFinite(nowMs)) return '--:--';
  const date = new Date(nowMs);
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
    } catch {
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }
  }
}

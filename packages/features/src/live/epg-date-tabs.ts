import type { AppI18n } from '@elv/i18n';
import { floorToEpgSlot } from './live-model';

/** Default number of multi-day EPG date tabs (`Today`, `Tomorrow`, and `+2d`..`+6d`, `#395`). */
export const EPG_DATE_TAB_COUNT = 7;

/** One DST-safe local calendar day tab rendered above the 30-minute EPG time ruler (`#395`). */
export interface EpgDateTab {
  readonly offsetDays: number;
  readonly dayKey: string;
  readonly dayStartMs: number;
  readonly label: string;
  readonly isToday: boolean;
}

/** Formats a local calendar `YYYY-MM-DD` key without relying on fixed 24-hour day math (`#395`). */
export function localDayKey(ms: number): string {
  if (!Number.isFinite(ms)) return '1970-01-01';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatFutureDayLabel(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' }).format(date);
  } catch {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
}

/**
 * Builds DST-safe local calendar day tabs (`Today`, `Tomorrow`, and `+2d`..`+(dayCount-1)d`)
 * using `new Date(y, m, d + offset)` so spring-forward/fall-back boundaries never skip or repeat days.
 */
export function buildEpgDateTabs(
  nowMs: number,
  i18n: Pick<AppI18n, 't' | 'locale'>,
  dayCount = EPG_DATE_TAB_COUNT,
): readonly EpgDateTab[] {
  const base = new Date(Number.isFinite(nowMs) ? nowMs : 0);
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  const tabs: EpgDateTab[] = [];
  for (let offset = 0; offset < Math.max(1, dayCount); offset++) {
    const localMidnight = new Date(y, m, d + offset, 0, 0, 0, 0);
    const dayStartMs = localMidnight.getTime();
    const label =
      offset === 0
        ? i18n.t('epg.today')
        : offset === 1
          ? i18n.t('epg.tomorrow')
          : formatFutureDayLabel(localMidnight, i18n.locale);
    tabs.push({
      offsetDays: offset,
      dayKey: localDayKey(dayStartMs),
      dayStartMs,
      label,
      isToday: offset === 0,
    });
  }
  return tabs;
}

/**
 * Computes the DST-safe `windowStartMs` when jumping to `dayStartMs` (`#395`).
 * Selecting Today snaps back to the live slot; selecting another day preserves the current local
 * time-of-day on that calendar date.
 */
export function computeDayJumpWindowStart(
  dayStartMs: number,
  nowMs: number,
  currentWindowStartMs: number,
): number {
  if (localDayKey(dayStartMs) === localDayKey(nowMs)) {
    return floorToEpgSlot(nowMs);
  }
  const targetDay = new Date(dayStartMs);
  const cur = new Date(currentWindowStartMs);
  const shifted = new Date(
    targetDay.getFullYear(),
    targetDay.getMonth(),
    targetDay.getDate(),
    cur.getHours(),
    cur.getMinutes(),
    0,
    0,
  );
  return Math.max(0, floorToEpgSlot(shifted.getTime()));
}

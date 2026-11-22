import { describe, expect, it } from 'vitest';
import {
  buildEpgDateTabs,
  computeDayJumpWindowStart,
  EPG_DATE_TAB_COUNT,
  localDayKey,
} from './epg-date-tabs';
import { EPG_SLOT_MS, floorToEpgSlot } from './live-model';

const stubI18n = {
  locale: 'en' as const,
  t: (id: string) => {
    if (id === 'epg.today') return 'Today';
    if (id === 'epg.tomorrow') return 'Tomorrow';
    return id;
  },
};

describe('epg-date-tabs (#395)', () => {
  it('builds 7 DST-safe local calendar day tabs starting with Today and Tomorrow', () => {
    const base = new Date(2026, 2, 7, 14, 15, 0, 0).getTime(); // day before US DST spring-forward
    const tabs = buildEpgDateTabs(base, stubI18n);
    expect(tabs).toHaveLength(EPG_DATE_TAB_COUNT);
    expect(tabs[0]?.label).toBe('Today');
    expect(tabs[0]?.isToday).toBe(true);
    expect(tabs[0]?.dayKey).toBe('2026-03-07');
    expect(tabs[1]?.label).toBe('Tomorrow');
    expect(tabs[1]?.isToday).toBe(false);
    expect(tabs[1]?.dayKey).toBe('2026-03-08');
    // Every consecutive tab must have a distinct local dayKey even across DST transitions
    const uniqueKeys = new Set(tabs.map((t) => t.dayKey));
    expect(uniqueKeys.size).toBe(EPG_DATE_TAB_COUNT);
    expect(tabs[6]?.dayKey).toBe('2026-03-13');
  });

  it('snaps Today back to live slot and preserves local time-of-day on future dates', () => {
    const now = new Date(2026, 5, 10, 19, 42, 0, 0).getTime();
    const currentWindow = new Date(2026, 5, 10, 20, 30, 0, 0).getTime();
    const todayStart = new Date(2026, 5, 10, 0, 0, 0, 0).getTime();
    const tomorrowStart = new Date(2026, 5, 11, 0, 0, 0, 0).getTime();

    expect(computeDayJumpWindowStart(todayStart, now, currentWindow)).toBe(floorToEpgSlot(now));

    const jumped = computeDayJumpWindowStart(tomorrowStart, now, currentWindow);
    const jumpedDate = new Date(jumped);
    expect(localDayKey(jumped)).toBe('2026-06-11');
    expect(jumpedDate.getHours()).toBe(20);
    expect(jumpedDate.getMinutes()).toBe(30);
    expect(jumped % EPG_SLOT_MS).toBe(0);
  });

  it('handles non-finite timestamps safely', () => {
    expect(localDayKey(Number.NaN)).toBe('1970-01-01');
  });
});

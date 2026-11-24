import type { ProgrammeReminderRecord } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  buildReminderTuneTarget,
  clampReminderTimerDelay,
  computeReminderStartsInMinutes,
  createReminderSchedulerEngine,
  MAX_REMINDER_MARK_ATTEMPTS,
  MAX_REMINDER_TIMER_DELAY_MS,
  pickEarliestDueReminder,
  REMINDER_MARK_RETRY_BACKOFF_MS,
  type ReminderBannerState,
  type ReminderTimers,
} from './app-shell-reminders';

function createManualTimers() {
  let nextId = 1;
  const active = new Map<number, { fn: () => void; delayMs: number }>();
  const timers: ReminderTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      active.set(id, { fn, delayMs: ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle) {
      active.delete(handle as unknown as number);
    },
  };
  return {
    timers,
    active,
    fireNext() {
      const first = active.entries().next().value;
      if (!first) return false;
      const [id, entry] = first;
      active.delete(id);
      entry.fn();
      return true;
    },
  };
}

const makeReminder = (
  overrides: Partial<ProgrammeReminderRecord> = {},
): ProgrammeReminderRecord => ({
  profileId: 'default',
  sourceId: 's1',
  channelKey: 'x:s1:live:1',
  channelName: 'News HD',
  programmeTitle: 'Evening News',
  programmeStart: 1_000_000,
  programmeStop: 4_600_000,
  leadTimeMs: 300_000,
  fired: false,
  createdAt: 1,
  ...overrides,
});

describe('app-shell-reminders', () => {
  it('clamps timer delays safely to MAX_REMINDER_TIMER_DELAY_MS and picks earliest due reminder', () => {
    expect(clampReminderTimerDelay(-50)).toBe(0);
    expect(clampReminderTimerDelay(Number.NaN)).toBe(0);
    expect(clampReminderTimerDelay(MAX_REMINDER_TIMER_DELAY_MS + 99_999)).toBe(
      MAX_REMINDER_TIMER_DELAY_MS,
    );
    expect(computeReminderStartsInMinutes(1_000_000, 700_000)).toBe(5);
    expect(computeReminderStartsInMinutes(1_000_000, 1_100_000)).toBe(0);

    const fired = makeReminder({ programmeStart: 800_000, fired: true });
    const expired = makeReminder({ programmeStart: 400_000, programmeStop: 500_000 });
    const later = makeReminder({
      channelKey: 'x:s1:live:2',
      programmeStart: 2_000_000,
      leadTimeMs: 300_000,
    });
    const earliest = makeReminder({
      channelKey: 'x:s1:live:3',
      programmeStart: 1_200_000,
      leadTimeMs: 600_000,
    });
    const picked = pickEarliestDueReminder([fired, expired, later, earliest], 550_000);
    expect(picked?.reminder.channelKey).toBe('x:s1:live:3');
    expect(picked?.dueAt).toBe(600_000);

    expect(buildReminderTuneTarget(earliest)).toEqual({
      itemKey: 'x:s1:live:3',
      sourceId: 's1',
      title: 'News HD',
      kind: 'live',
      itemKind: 'live',
    });
  });

  it('schedules only ONE timer, fires banner + reminderHost, marks fired, and advances to next reminder', async () => {
    let now = 500_000;
    const manual = createManualTimers();
    const banners: ReminderBannerState[] = [];
    const notifyReminder = vi.fn();

    let rows: ProgrammeReminderRecord[] = [
      makeReminder({
        channelKey: 'x:s1:live:1',
        programmeTitle: 'Show A',
        programmeStart: 1_000_000,
        leadTimeMs: 300_000, // dueAt 700_000
      }),
      makeReminder({
        channelKey: 'x:s1:live:2',
        programmeTitle: 'Show B',
        programmeStart: 1_500_000,
        leadTimeMs: 300_000, // dueAt 1_200_000
      }),
    ];

    const markReminderFired = vi.fn(async (channelKey: string, start: number) => {
      rows = rows.map((r) =>
        r.channelKey === channelKey && r.programmeStart === start ? { ...r, fired: true } : r,
      );
      return ok(undefined);
    });
    const pruneExpiredReminders = vi.fn(async () => 0);
    const itemDetail = vi.fn(async (key: string) => ({ key }));

    const engine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: itemDetail as never,
        listReminders: vi.fn(async () => rows.filter((r) => !r.fired)),
        markReminderFired,
        pruneExpiredReminders,
      },
      activeProfileId: 'default',
      parentalUnlocked: false,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      onBanner: (b) => banners.push(b),
    });

    await engine.sync();
    expect(pruneExpiredReminders).toHaveBeenCalledWith(500_000);
    // Strictly ONE timer scheduled for Show A (700_000 - 500_000 = 200_000)
    expect(manual.active.size).toBe(1);
    expect([...manual.active.values()][0]?.delayMs).toBe(200_000);

    now = 700_000;
    manual.fireNext();
    await new Promise((r) => setTimeout(r, 0));

    expect(itemDetail).toHaveBeenCalledWith('x:s1:live:1', {
      profileId: 'default',
      parentalUnlocked: false,
    });
    expect(markReminderFired).toHaveBeenCalledWith('x:s1:live:1', 1_000_000, 'default');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.reminder.programmeTitle).toBe('Show A');
    expect(banners[0]?.startsInMinutes).toBe(5);
    expect(notifyReminder).toHaveBeenCalledWith({
      channelKey: 'x:s1:live:1',
      channelName: 'News HD',
      programmeTitle: 'Show A',
      programmeStart: 1_000_000,
      startsInMinutes: 5,
    });
    // Next timer automatically armed for Show B (1_200_000 - 700_000 = 500_000)
    expect(manual.active.size).toBe(1);
    expect([...manual.active.values()][0]?.delayMs).toBe(500_000);

    engine.dispose();
    expect(manual.active.size).toBe(0);
  });

  it('suppresses restricted channel reminders silently under parental lock without leaking title or calling reminderHost (#31)', async () => {
    const now = 700_000;
    const manual = createManualTimers();
    const banners: ReminderBannerState[] = [];
    const notifyReminder = vi.fn();
    let fired = false;

    const markReminderFired = vi.fn(async () => {
      fired = true;
      return ok(undefined);
    });
    const getItem = vi.fn(async () => null);

    const engine = createReminderSchedulerEngine({
      catalog: {
        getItem,
        listReminders: vi.fn(async () =>
          fired
            ? []
            : [
                makeReminder({
                  profileId: 'kids-1',
                  channelKey: 'x:s1:live:adult',
                  programmeTitle: 'Restricted Title',
                  programmeStart: 1_000_000,
                  leadTimeMs: 300_000,
                }),
              ],
        ),
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'kids-1',
      parentalUnlocked: false,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      onBanner: (b) => banners.push(b),
    });

    await engine.sync();
    expect(getItem).toHaveBeenCalledWith('x:s1:live:adult', {
      profileId: 'kids-1',
      parentalUnlocked: false,
    });
    expect(markReminderFired).toHaveBeenCalledWith('x:s1:live:adult', 1_000_000, 'kids-1');
    expect(banners).toHaveLength(0);
    expect(notifyReminder).not.toHaveBeenCalled();

    engine.dispose();
  });

  it('re-arms intermediate timer without premature firing when delay exceeds MAX_REMINDER_TIMER_DELAY_MS', async () => {
    let now = 1_000;
    const manual = createManualTimers();
    const banners: ReminderBannerState[] = [];
    const farStart = now + MAX_REMINDER_TIMER_DELAY_MS + 600_000;
    const markReminderFired = vi.fn(async () => ok(undefined));

    const engine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: vi.fn(async () => ({ key: 'x:s1:live:1' })) as never,
        listReminders: vi.fn(async () => [
          makeReminder({
            programmeStart: farStart,
            programmeStop: farStart + 3_600_000,
            leadTimeMs: 0,
          }),
        ]),
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'default',
      parentalUnlocked: false,
      clock: () => now,
      timers: manual.timers,
      onBanner: (b) => banners.push(b),
    });

    await engine.sync();
    expect(manual.active.size).toBe(1);
    expect([...manual.active.values()][0]?.delayMs).toBe(MAX_REMINDER_TIMER_DELAY_MS);

    now += MAX_REMINDER_TIMER_DELAY_MS;
    manual.fireNext();
    await new Promise((r) => setTimeout(r, 0));

    expect(banners).toHaveLength(0);
    expect(markReminderFired).not.toHaveBeenCalled();
    expect(manual.active.size).toBe(1);
    expect([...manual.active.values()][0]?.delayMs).toBe(600_000);

    engine.dispose();
  });

  it('backs off without infinite recursion or notification spam when markReminderFired fails or throws (#6)', async () => {
    let now = 700_000;
    const manual = createManualTimers();
    const banners: ReminderBannerState[] = [];
    const notifyReminder = vi.fn();
    let callCount = 0;

    const markReminderFired = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return err(elvError('storage', 'db-busy'));
      throw new Error('disk busy');
    });

    const engine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: vi.fn(async () => ({ key: 'x:s1:live:1' })) as never,
        listReminders: vi.fn(async () => [
          makeReminder({ programmeStart: 1_000_000, leadTimeMs: 300_000 }),
        ]),
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'default',
      parentalUnlocked: false,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      onBanner: (b) => banners.push(b),
    });

    await engine.sync();
    // Must attempt once, NOT recurse infinitely, NOT spam banner/notifications, and arm 60s backoff timer.
    expect(markReminderFired).toHaveBeenCalledTimes(1);
    expect(banners).toHaveLength(0);
    expect(notifyReminder).not.toHaveBeenCalled();
    expect(manual.active.size).toBe(1);
    expect([...manual.active.values()][0]?.delayMs).toBe(REMINDER_MARK_RETRY_BACKOFF_MS);

    // Exhaust remaining attempts up to MAX_REMINDER_MARK_ATTEMPTS, then stop scheduling retries.
    for (let attempt = 2; attempt <= MAX_REMINDER_MARK_ATTEMPTS; attempt += 1) {
      now += REMINDER_MARK_RETRY_BACKOFF_MS;
      manual.fireNext();
      await new Promise((r) => setTimeout(r, 0));
      expect(markReminderFired).toHaveBeenCalledTimes(attempt);
    }
    expect(banners).toHaveLength(0);
    expect(notifyReminder).not.toHaveBeenCalled();
    expect(manual.active.size).toBe(0);

    engine.dispose();
  });

  it('passes parentalUnlocked to listReminders, suppresses programme-restricted reminders, and populates localized timingText (#4, #16)', async () => {
    let now = 700_000;
    const manual = createManualTimers();
    const banners: ReminderBannerState[] = [];
    const notifyReminder = vi.fn();
    const listReminders = vi.fn(
      async (_profileId?: string, opts?: { parentalUnlocked?: boolean }) =>
        opts?.parentalUnlocked
          ? [
              makeReminder({
                channelKey: 'x:s1:live:1',
                programmeTitle: 'Late Night Show',
                programmeStart: 1_000_000,
                leadTimeMs: 300_000,
              }),
            ]
          : [],
    );
    let fired = false;
    const markReminderFired = vi.fn(async () => {
      fired = true;
      return ok(undefined);
    });

    // When locked, listReminders returns [] -> nothing fires or leaks.
    const lockedEngine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: vi.fn(async () => ({ key: 'x:s1:live:1' })) as never,
        listReminders,
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'kids-1',
      parentalUnlocked: false,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      formatTimingText: (mins) => (mins <= 0 ? 'Şimdi başlıyor' : `${mins} dk içinde başlıyor`),
      onBanner: (b) => banners.push(b),
    });
    await lockedEngine.sync();
    expect(listReminders).toHaveBeenCalledWith('kids-1', {
      includeFired: false,
      parentalUnlocked: false,
    });
    expect(banners).toHaveLength(0);
    expect(notifyReminder).not.toHaveBeenCalled();
    lockedEngine.dispose();

    // When unlocked, localized timingText is forwarded on ReminderNotificationPayload.
    const unlockedEngine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: vi.fn(async () => ({ key: 'x:s1:live:1' })) as never,
        listReminders: vi.fn(async (pid, opts) => (fired ? [] : listReminders(pid, opts))),
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'kids-1',
      parentalUnlocked: true,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      formatTimingText: (mins) => (mins <= 0 ? 'Şimdi başlıyor' : `${mins} dk içinde başlıyor`),
      onBanner: (b) => banners.push(b),
    });
    await unlockedEngine.sync();
    expect(banners).toHaveLength(1);
    expect(notifyReminder).toHaveBeenCalledWith({
      channelKey: 'x:s1:live:1',
      channelName: 'News HD',
      programmeTitle: 'Late Night Show',
      programmeStart: 1_000_000,
      startsInMinutes: 5,
      timingText: '5 dk içinde başlıyor',
    });
    unlockedEngine.dispose();

    // Starting-now formatting when programmeStart <= now
    now = 1_000_000;
    fired = false;
    const nowEngine = createReminderSchedulerEngine({
      catalog: {
        itemDetail: vi.fn(async () => ({ key: 'x:s1:live:1' })) as never,
        listReminders: vi.fn(async (pid, opts) => (fired ? [] : listReminders(pid, opts))),
        markReminderFired,
        pruneExpiredReminders: vi.fn(async () => 0),
      },
      activeProfileId: 'kids-1',
      parentalUnlocked: true,
      reminderHost: { notifyReminder },
      clock: () => now,
      timers: manual.timers,
      formatTimingText: (mins) => (mins <= 0 ? 'Şimdi başlıyor' : `${mins} dk içinde başlıyor`),
      onBanner: (b) => banners.push(b),
    });
    await nowEngine.sync();
    expect(notifyReminder).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startsInMinutes: 0,
        timingText: 'Şimdi başlıyor',
      }),
    );
    nowEngine.dispose();
  });
});

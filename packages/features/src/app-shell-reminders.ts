import type { CatalogService, ParentalQueryOptions, ProgrammeReminderRecord } from '@elv/data';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from './ports/play-target';
import type { ReminderHostPort } from './ports/reminder-host';

/** Maximum safe 32-bit signed `setTimeout` delay in milliseconds (`2^31 - 1`). */
export const MAX_REMINDER_TIMER_DELAY_MS = 2_147_483_647;

/** Active floating reminder banner state surfaced in {@link AppShell} (`#35`). */
export interface ReminderBannerState {
  readonly reminder: ProgrammeReminderRecord;
  readonly startsInMinutes: number;
}

/** Timer abstraction enabling deterministic unit testing of the reminder scheduler. */
export interface ReminderTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMERS: ReminderTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/** Clamps a scheduler delay to `[0, MAX_REMINDER_TIMER_DELAY_MS]` preventing 32-bit timer overflow. */
export function clampReminderTimerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
  return Math.min(Math.round(delayMs), MAX_REMINDER_TIMER_DELAY_MS);
}

/** Computes whole minutes until `programmeStart` from `nowMs`, clamped to `>= 0`. */
export function computeReminderStartsInMinutes(programmeStart: number, nowMs: number): number {
  const diff = programmeStart - nowMs;
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return Math.max(0, Math.round(diff / 60_000));
}

/** Picks the earliest unfired, non-expired reminder by `dueAt = programmeStart - leadTimeMs`. */
export function pickEarliestDueReminder(
  reminders: readonly ProgrammeReminderRecord[],
  nowMs: number,
): { readonly reminder: ProgrammeReminderRecord; readonly dueAt: number } | null {
  let best: { readonly reminder: ProgrammeReminderRecord; readonly dueAt: number } | null = null;
  for (const reminder of reminders) {
    if (reminder.fired) continue;
    if (reminder.programmeStop <= nowMs) continue;
    const lead = Number.isFinite(reminder.leadTimeMs) ? Math.max(0, reminder.leadTimeMs) : 0;
    const dueAt = reminder.programmeStart - lead;
    if (
      best === null ||
      dueAt < best.dueAt ||
      (dueAt === best.dueAt && reminder.programmeStart < best.reminder.programmeStart)
    ) {
      best = { reminder, dueAt };
    }
  }
  return best;
}

/** Builds a live {@link PlayTarget} from a fired programme reminder (`#35`). */
export function buildReminderTuneTarget(reminder: ProgrammeReminderRecord): PlayTarget {
  return {
    itemKey: reminder.channelKey,
    sourceId: reminder.sourceId,
    title: reminder.channelName,
    kind: 'live',
    itemKind: 'live',
  };
}

type ReminderCatalog = Pick<
  CatalogService,
  'itemDetail' | 'listReminders' | 'markReminderFired' | 'pruneExpiredReminders'
> & {
  /** Optional alias accepted by unit tests or lightweight catalog facades. */
  getItem?(itemKey: string, opts?: ParentalQueryOptions): Promise<unknown>;
};

async function isReminderChannelPermitted(
  catalog: ReminderCatalog,
  channelKey: string,
  profileId: string,
  parentalUnlocked: boolean,
): Promise<boolean> {
  const opts: ParentalQueryOptions = { profileId, parentalUnlocked };
  if (typeof catalog.getItem === 'function') {
    const found = await catalog.getItem(channelKey, opts).catch(() => null);
    return found != null;
  }
  if (typeof catalog.itemDetail === 'function') {
    const found = await catalog.itemDetail(channelKey, opts).catch(() => null);
    return found != null;
  }
  return true;
}

/** Options of {@link createReminderSchedulerEngine}. */
export interface ReminderSchedulerEngineOptions {
  readonly catalog: ReminderCatalog;
  readonly activeProfileId: string;
  readonly parentalUnlocked: boolean;
  readonly reminderHost?: ReminderHostPort;
  readonly clock?: () => number;
  readonly timers?: ReminderTimers;
  readonly onBanner: (banner: ReminderBannerState) => void;
}

/** Handle returned by {@link createReminderSchedulerEngine}. */
export interface ReminderSchedulerEngine {
  /** Prunes expired reminders, loads unfired reminders, and arms a single timer for the earliest due one. */
  sync(): Promise<void>;
  /** Cancels any pending timer and ignores in-flight async completions. */
  dispose(): void;
}

/**
 * Pure single-timer reminder scheduler engine (`#35`).
 * Guarantees at most ONE active `setTimeout`, clamps delays to `MAX_REMINDER_TIMER_DELAY_MS`,
 * enforces parental controls (`#31`) before displaying or notifying, and never auto-steals playback.
 */
export function createReminderSchedulerEngine(
  opts: ReminderSchedulerEngineOptions,
): ReminderSchedulerEngine {
  const clock = opts.clock ?? Date.now;
  const timers = opts.timers ?? DEFAULT_TIMERS;
  let disposed = false;
  let gen = 0;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timerHandle !== undefined) {
      timers.clearTimeout(timerHandle);
      timerHandle = undefined;
    }
  };

  const fireAndContinue = async (
    reminder: ProgrammeReminderRecord,
    runGen: number,
  ): Promise<void> => {
    if (disposed || runGen !== gen) return;
    const now = clock();
    const permitted = await isReminderChannelPermitted(
      opts.catalog,
      reminder.channelKey,
      opts.activeProfileId,
      opts.parentalUnlocked,
    );
    if (disposed || runGen !== gen) return;

    await opts.catalog
      .markReminderFired?.(reminder.channelKey, reminder.programmeStart, opts.activeProfileId)
      .catch(() => undefined);
    if (disposed || runGen !== gen) return;

    if (permitted && reminder.programmeStop > now) {
      const startsInMinutes = computeReminderStartsInMinutes(reminder.programmeStart, now);
      opts.onBanner({ reminder, startsInMinutes });
      try {
        opts.reminderHost?.notifyReminder({
          channelKey: reminder.channelKey,
          channelName: reminder.channelName,
          programmeTitle: reminder.programmeTitle,
          programmeStart: reminder.programmeStart,
          startsInMinutes,
        });
      } catch {
        // Isolate host OS notification errors from the scheduler loop.
      }
    }

    await syncInternal(runGen);
  };

  const syncInternal = async (runGen: number): Promise<void> => {
    if (disposed || runGen !== gen) return;
    clearTimer();
    if (opts.catalog.listReminders === undefined) return;

    const now = clock();
    await opts.catalog.pruneExpiredReminders?.(now).catch(() => 0);
    if (disposed || runGen !== gen) return;

    const list = await opts.catalog
      .listReminders(opts.activeProfileId, { includeFired: false })
      .catch(() => [] as ProgrammeReminderRecord[]);
    if (disposed || runGen !== gen) return;

    const afterLoadNow = clock();
    const next = pickEarliestDueReminder(list, afterLoadNow);
    if (next === null) return;

    const remainingMs = next.dueAt - afterLoadNow;
    if (remainingMs <= 0) {
      await fireAndContinue(next.reminder, runGen);
      return;
    }

    const clampedMs = clampReminderTimerDelay(remainingMs);
    const needsIntermediateWake = remainingMs > MAX_REMINDER_TIMER_DELAY_MS;
    timerHandle = timers.setTimeout(() => {
      timerHandle = undefined;
      if (disposed || runGen !== gen) return;
      if (needsIntermediateWake) {
        void syncInternal(runGen);
      } else {
        void fireAndContinue(next.reminder, runGen);
      }
    }, clampedMs);
  };

  return {
    async sync() {
      if (disposed) return;
      const runGen = ++gen;
      await syncInternal(runGen);
    },
    dispose() {
      disposed = true;
      gen += 1;
      clearTimer();
    },
  };
}

/** Options of {@link useProgrammeReminders}. */
export interface UseProgrammeRemindersOptions {
  readonly catalog: ReminderCatalog;
  readonly activeProfileId: string;
  readonly parentalUnlocked: boolean;
  readonly catalogRevision?: number;
  readonly reminderVersion?: number;
  readonly onTuneChannel: (target: PlayTarget) => void;
  readonly reminderHost?: ReminderHostPort;
  readonly clock?: () => number;
  readonly timers?: ReminderTimers;
}

/** Return handle of {@link useProgrammeReminders}. */
export interface ProgrammeRemindersHandle {
  readonly activeBanner: ReminderBannerState | null;
  readonly dismissBanner: () => void;
  readonly tuneActiveBanner: () => void;
  readonly refreshReminders: () => void;
}

/**
 * App-wide single-timer programme reminder scheduler (`#35`) integrated into `AppShell`.
 * Prunes expired rows, schedules a single overflow-safe timer for the next due reminder,
 * guards firing with active profile parental controls (`#31`), and never auto-steals playback.
 */
export function useProgrammeReminders({
  catalog,
  activeProfileId,
  parentalUnlocked,
  catalogRevision = 0,
  reminderVersion = 0,
  onTuneChannel,
  reminderHost,
  clock,
  timers,
}: UseProgrammeRemindersOptions): ProgrammeRemindersHandle {
  const [activeBanner, setActiveBanner] = useState<ReminderBannerState | null>(null);
  const [localTick, setLocalTick] = useState(0);
  const onTuneRef = useRef(onTuneChannel);
  onTuneRef.current = onTuneChannel;
  const activeBannerRef = useRef<ReminderBannerState | null>(null);
  activeBannerRef.current = activeBanner;

  const prevScopeRef = useRef({ activeProfileId, parentalUnlocked });
  useEffect(() => {
    const prev = prevScopeRef.current;
    prevScopeRef.current = { activeProfileId, parentalUnlocked };
    if (prev.activeProfileId !== activeProfileId || (prev.parentalUnlocked && !parentalUnlocked)) {
      setActiveBanner(null);
    }
  }, [activeProfileId, parentalUnlocked]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogRevision, reminderVersion, and localTick intentionally trigger reminder resync
  useEffect(() => {
    const engine = createReminderSchedulerEngine({
      catalog,
      activeProfileId,
      parentalUnlocked,
      ...(reminderHost !== undefined ? { reminderHost } : {}),
      ...(clock !== undefined ? { clock } : {}),
      ...(timers !== undefined ? { timers } : {}),
      onBanner: setActiveBanner,
    });
    void engine.sync();
    return () => engine.dispose();
  }, [
    activeProfileId,
    catalog,
    catalogRevision,
    clock,
    localTick,
    parentalUnlocked,
    reminderHost,
    reminderVersion,
    timers,
  ]);

  const dismissBanner = useCallback(() => {
    setActiveBanner(null);
  }, []);

  const tuneActiveBanner = useCallback(() => {
    const current = activeBannerRef.current;
    if (current === null) return;
    setActiveBanner(null);
    onTuneRef.current(buildReminderTuneTarget(current.reminder));
  }, []);

  const refreshReminders = useCallback(() => {
    setLocalTick((n) => n + 1);
  }, []);

  return {
    activeBanner,
    dismissBanner,
    tuneActiveBanner,
    refreshReminders,
  };
}

import type { CatalogService, ParentalQueryOptions, ProgrammeReminderRecord } from '@elv/data';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from './ports/play-target';
import type { ReminderHostPort } from './ports/reminder-host';

/** Maximum safe 32-bit signed `setTimeout` delay in milliseconds (`2^31 - 1`). */
export const MAX_REMINDER_TIMER_DELAY_MS = 2_147_483_647;

/** Cooldown before retrying a reminder whose `markReminderFired` persistence failed (`#35`). */
export const REMINDER_MARK_RETRY_BACKOFF_MS = 60_000;

/** Maximum failed `markReminderFired` attempts for a single reminder key in one scheduler lifecycle. */
export const MAX_REMINDER_MARK_ATTEMPTS = 3;

/** Builds the canonical in-memory key for a scheduled programme reminder (`channelKey|programmeStart`). */
function reminderMarkKey(channelKey: string, programmeStart: number): string {
  return `${channelKey}|${programmeStart}`;
}

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
  /** Optional localized timing formatter (e.g. `epg.reminderStartsIn` / `epg.reminderStartingNow`). */
  readonly formatTimingText?: (startsInMinutes: number) => string;
  /** Optional extra parental/visibility check evaluated right before showing a reminder. */
  readonly isReminderPermitted?: (reminder: ProgrammeReminderRecord) => boolean | Promise<boolean>;
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
 * enforces parental controls (`#31`) before displaying or notifying, backs off failed persistence
 * writes without infinite recursion, and never auto-steals playback.
 */
export function createReminderSchedulerEngine(
  opts: ReminderSchedulerEngineOptions,
): ReminderSchedulerEngine {
  const clock = opts.clock ?? Date.now;
  const timers = opts.timers ?? DEFAULT_TIMERS;
  const failedMarks = new Map<string, { attempts: number; retryAfterMs: number }>();
  let disposed = false;
  let gen = 0;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timerHandle !== undefined) {
      timers.clearTimeout(timerHandle);
      timerHandle = undefined;
    }
  };

  const loadUnfiredReminders = async (): Promise<ProgrammeReminderRecord[]> => {
    if (opts.catalog.listReminders === undefined) return [];
    return opts.catalog
      .listReminders(opts.activeProfileId, {
        includeFired: false,
        parentalUnlocked: opts.parentalUnlocked,
      })
      .catch(() => [] as ProgrammeReminderRecord[]);
  };

  const fireAndContinue = async (
    reminder: ProgrammeReminderRecord,
    runGen: number,
  ): Promise<void> => {
    if (disposed || runGen !== gen) return;
    const key = reminderMarkKey(reminder.channelKey, reminder.programmeStart);
    const now = clock();

    // Re-verify reminder is still present and permitted under active profile + programme parental policy.
    let stillListed = true;
    if (opts.catalog.listReminders !== undefined) {
      const currentRows = await loadUnfiredReminders();
      if (disposed || runGen !== gen) return;
      stillListed = currentRows.some(
        (r) => r.channelKey === reminder.channelKey && r.programmeStart === reminder.programmeStart,
      );
    }
    if (!stillListed) {
      await syncInternal(runGen);
      return;
    }

    const channelPermitted = await isReminderChannelPermitted(
      opts.catalog,
      reminder.channelKey,
      opts.activeProfileId,
      opts.parentalUnlocked,
    );
    if (disposed || runGen !== gen) return;

    const customPermitted = opts.isReminderPermitted
      ? await Promise.resolve(opts.isReminderPermitted(reminder)).catch(() => false)
      : true;
    if (disposed || runGen !== gen) return;

    const permitted = channelPermitted && customPermitted;

    let markOk = true;
    if (opts.catalog.markReminderFired !== undefined) {
      try {
        const res = await opts.catalog.markReminderFired(
          reminder.channelKey,
          reminder.programmeStart,
          opts.activeProfileId,
        );
        if (res !== undefined && res !== null && res.ok === false) {
          markOk = false;
        }
      } catch {
        markOk = false;
      }
    }
    if (disposed || runGen !== gen) return;

    if (!markOk) {
      const prev = failedMarks.get(key);
      failedMarks.set(key, {
        attempts: (prev?.attempts ?? 0) + 1,
        retryAfterMs: clock() + REMINDER_MARK_RETRY_BACKOFF_MS,
      });
      await syncInternal(runGen);
      return;
    }
    failedMarks.delete(key);

    if (permitted && reminder.programmeStop > now) {
      const startsInMinutes = computeReminderStartsInMinutes(reminder.programmeStart, now);
      const timingText = opts.formatTimingText?.(startsInMinutes);
      opts.onBanner({ reminder, startsInMinutes });
      try {
        opts.reminderHost?.notifyReminder({
          channelKey: reminder.channelKey,
          channelName: reminder.channelName,
          programmeTitle: reminder.programmeTitle,
          programmeStart: reminder.programmeStart,
          startsInMinutes,
          ...(timingText !== undefined ? { timingText } : {}),
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

    const list = await loadUnfiredReminders();
    if (disposed || runGen !== gen) return;

    const afterLoadNow = clock();
    const eligible: ProgrammeReminderRecord[] = [];
    let earliestRetryAt: number | null = null;
    for (const row of list) {
      const fail = failedMarks.get(reminderMarkKey(row.channelKey, row.programmeStart));
      if (fail !== undefined) {
        if (fail.attempts >= MAX_REMINDER_MARK_ATTEMPTS) continue;
        if (fail.retryAfterMs > afterLoadNow) {
          if (earliestRetryAt === null || fail.retryAfterMs < earliestRetryAt) {
            earliestRetryAt = fail.retryAfterMs;
          }
          continue;
        }
      }
      eligible.push(row);
    }

    const next = pickEarliestDueReminder(eligible, afterLoadNow);
    if (next !== null && next.dueAt - afterLoadNow <= 0) {
      await fireAndContinue(next.reminder, runGen);
      return;
    }

    const nextDueAt = next?.dueAt ?? null;
    const wakeAt =
      nextDueAt !== null && earliestRetryAt !== null
        ? Math.min(nextDueAt, earliestRetryAt)
        : (nextDueAt ?? earliestRetryAt);
    if (wakeAt === null) return;

    const remainingMs = wakeAt - afterLoadNow;
    const clampedMs = clampReminderTimerDelay(remainingMs);
    const shouldFireDirectly =
      next !== null && wakeAt === next.dueAt && remainingMs <= MAX_REMINDER_TIMER_DELAY_MS;
    timerHandle = timers.setTimeout(() => {
      timerHandle = undefined;
      if (disposed || runGen !== gen) return;
      if (shouldFireDirectly) {
        void fireAndContinue(next.reminder, runGen);
      } else {
        void syncInternal(runGen);
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
  readonly profileRevision?: number;
  readonly catalogRevision?: number;
  readonly reminderVersion?: number;
  readonly onTuneChannel: (target: PlayTarget) => void;
  readonly reminderHost?: ReminderHostPort;
  readonly formatTimingText?: (startsInMinutes: number) => string;
  readonly isReminderPermitted?: (reminder: ProgrammeReminderRecord) => boolean | Promise<boolean>;
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
  profileRevision = 0,
  catalogRevision = 0,
  reminderVersion = 0,
  onTuneChannel,
  reminderHost,
  formatTimingText,
  isReminderPermitted,
  clock,
  timers,
}: UseProgrammeRemindersOptions): ProgrammeRemindersHandle {
  const [activeBanner, setActiveBanner] = useState<ReminderBannerState | null>(null);
  const [localTick, setLocalTick] = useState(0);
  const onTuneRef = useRef(onTuneChannel);
  onTuneRef.current = onTuneChannel;
  const formatTimingTextRef = useRef(formatTimingText);
  formatTimingTextRef.current = formatTimingText;
  const isReminderPermittedRef = useRef(isReminderPermitted);
  isReminderPermittedRef.current = isReminderPermitted;
  const activeBannerRef = useRef<ReminderBannerState | null>(null);
  activeBannerRef.current = activeBanner;

  const prevScopeRef = useRef({ activeProfileId, parentalUnlocked, profileRevision });
  useEffect(() => {
    const prev = prevScopeRef.current;
    prevScopeRef.current = { activeProfileId, parentalUnlocked, profileRevision };
    if (
      prev.activeProfileId !== activeProfileId ||
      (!parentalUnlocked && (prev.parentalUnlocked || prev.profileRevision !== profileRevision))
    ) {
      setActiveBanner(null);
    }
  }, [activeProfileId, parentalUnlocked, profileRevision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogRevision, profileRevision, reminderVersion, and localTick intentionally trigger reminder resync
  useEffect(() => {
    const engine = createReminderSchedulerEngine({
      catalog,
      activeProfileId,
      parentalUnlocked,
      ...(reminderHost !== undefined ? { reminderHost } : {}),
      ...(formatTimingTextRef.current !== undefined
        ? { formatTimingText: (mins) => formatTimingTextRef.current?.(mins) ?? '' }
        : {}),
      ...(isReminderPermittedRef.current !== undefined
        ? {
            isReminderPermitted: (r) => isReminderPermittedRef.current?.(r) ?? true,
          }
        : {}),
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
    profileRevision,
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

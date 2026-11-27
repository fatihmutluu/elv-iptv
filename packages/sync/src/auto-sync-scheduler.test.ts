import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAutoSyncScheduler,
  DEFAULT_BACKGROUND_FLUSH_TIMEOUT_MS,
  DEFAULT_FOREGROUND_MIN_AWAY_MS,
  DEFAULT_MUTATION_DEBOUNCE_MS,
  DEFAULT_PAUSE_DEBOUNCE_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_VIEWING_HEARTBEAT_MS,
} from './auto-sync-scheduler';

describe('createAutoSyncScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the expected Wave P9 timing constants and debounces mutations (3s) and playback pause (2s)', async () => {
    expect(DEFAULT_MUTATION_DEBOUNCE_MS).toBe(3_000);
    expect(DEFAULT_PAUSE_DEBOUNCE_MS).toBe(2_000);
    expect(DEFAULT_VIEWING_HEARTBEAT_MS).toBe(180_000);
    expect(DEFAULT_FOREGROUND_MIN_AWAY_MS).toBe(60_000);
    expect(DEFAULT_BACKGROUND_FLUSH_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_RETRY_BACKOFF_MS).toEqual([5_000, 15_000, 45_000, 120_000]);

    const syncPush = vi.fn(async () => undefined);
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    // Rapid mutations coalesce into a single 3s debounced push
    scheduler.notifyMutation();
    await vi.advanceTimersByTimeAsync(2_000);
    scheduler.notifyMutation();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(syncPush).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Playback pause debounces 2s
    scheduler.notifyPlaybackPause();
    await vi.advanceTimersByTimeAsync(1_900);
    expect(syncPush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(syncPush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('pushes immediately on playback exit/switch and cancels pending pause and mutation timers', async () => {
    const syncPush = vi.fn(async () => undefined);
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.notifyMutation();
    scheduler.notifyPlaybackPause();
    scheduler.notifyPlaybackExitOrSwitch();
    await Promise.resolve();
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Advancing past old 2s/3s debounce windows must NOT trigger duplicate pushes
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncPush).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('runs 3-minute periodic viewing heartbeat push only while viewing is active and dirty', async () => {
    const syncPush = vi.fn(async () => undefined);
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.setViewingActive(true);
    // Clean heartbeat ticks do not push
    await vi.advanceTimersByTimeAsync(180_000);
    expect(syncPush).toHaveBeenCalledTimes(0);

    // Marking dirty while viewing pushes on the 3-minute heartbeat
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Next heartbeat with no new dirty mark is skipped
    await vi.advanceTimersByTimeAsync(180_000);
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Stopping viewing cancels the heartbeat interval
    scheduler.setViewingActive(false);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(360_000);
    expect(syncPush).toHaveBeenCalledTimes(1);

    scheduler.dispose();
  });

  it('handles startup pull, foreground pull (>= 60s), reconnect pull+flush, and bounded flushBeforeBackground', async () => {
    const events: string[] = [];
    const syncPush = vi.fn(async () => {
      events.push('push');
    });
    const syncPull = vi.fn(async () => {
      events.push('pull');
    });
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.notifyStartup();
    await Promise.resolve();
    expect(events).toEqual(['pull']);

    // Short background (< 60s) skips pull
    scheduler.notifyForeground(59_999);
    await Promise.resolve();
    expect(events).toEqual(['pull']);

    // Long background (>= 60s) triggers pull
    scheduler.notifyForeground(60_000);
    await Promise.resolve();
    expect(events).toEqual(['pull', 'pull']);

    // Reconnect pulls and flushes dirty queue
    scheduler.markDirty();
    scheduler.notifyReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['pull', 'pull', 'pull', 'push']);

    // flushBeforeBackground skips when clean
    await scheduler.flushBeforeBackground(1_000);
    expect(syncPush).toHaveBeenCalledTimes(1);

    // flushBeforeBackground pushes immediately when dirty and cancels debounce timer
    scheduler.notifyMutation();
    await scheduler.flushBeforeBackground(1_000);
    expect(syncPush).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncPush).toHaveBeenCalledTimes(2);

    scheduler.dispose();
  });

  it('never hangs past flushBeforeBackground timeout when syncPush stalls', async () => {
    const syncPush = vi.fn(() => new Promise<void>(() => {}));
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.markDirty();
    let settled = false;
    const flushPromise = scheduler.flushBeforeBackground(500).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromise;
    expect(settled).toBe(true);

    scheduler.dispose();
  });

  it('enforces single-flight execution and preserves mutations arriving mid-push', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const resolvers: Array<() => void> = [];

    const syncPush = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      inFlight -= 1;
    });
    const syncPull = vi.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
      inFlight -= 1;
    });

    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.notifyStartup();
    scheduler.notifyPlaybackExitOrSwitch();
    expect(syncPull).toHaveBeenCalledTimes(1);
    expect(syncPush).toHaveBeenCalledTimes(0);

    // Complete pull -> queued push starts right after
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncPush).toHaveBeenCalledTimes(1);

    // New mutation arrives while push #1 is in flight!
    scheduler.notifyPlaybackExitOrSwitch();
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Complete push #1 -> push #2 runs to flush mid-flight mutation
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncPush).toHaveBeenCalledTimes(2);

    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(maxConcurrent).toBe(1);
    expect(scheduler.getStatus().dirty).toBe(false);
    scheduler.dispose();
  });

  it('retries failed syncs with 5s -> 15s -> 45s -> 120s capped exponential backoff and resets on success or reconnect', async () => {
    let shouldFail = true;
    const syncPush = vi.fn(async () => {
      if (shouldFail) throw new Error('offline');
    });
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    scheduler.notifyPlaybackExitOrSwitch();
    await vi.advanceTimersByTimeAsync(0);
    expect(syncPush).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().consecutiveFailures).toBe(1);

    // Retry #1 after 5s
    await vi.advanceTimersByTimeAsync(4_999);
    expect(syncPush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncPush).toHaveBeenCalledTimes(2);

    // Retry #2 after 15s
    await vi.advanceTimersByTimeAsync(14_999);
    expect(syncPush).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncPush).toHaveBeenCalledTimes(3);

    // Retry #3 after 45s
    await vi.advanceTimersByTimeAsync(44_999);
    expect(syncPush).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncPush).toHaveBeenCalledTimes(4);

    // Retry #4 after 120s (capped!)
    await vi.advanceTimersByTimeAsync(119_999);
    expect(syncPush).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncPush).toHaveBeenCalledTimes(5);

    // Retry #5 still capped at 120s, and succeeds -> resets consecutiveFailures
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncPush).toHaveBeenCalledTimes(6);
    expect(scheduler.getStatus().consecutiveFailures).toBe(0);
    expect(scheduler.getStatus().dirty).toBe(false);

    scheduler.dispose();
  });

  it('suppresses all sync operations when signed out and cleans up all timers on dispose()', async () => {
    let signedIn = false;
    const syncPush = vi.fn(async () => undefined);
    const syncPull = vi.fn(async () => undefined);
    const statuses: string[] = [];

    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => signedIn,
    });
    const unsub = scheduler.subscribe((s) => statuses.push(s.state));

    scheduler.notifyStartup();
    scheduler.notifyMutation();
    scheduler.notifyPlaybackPause();
    scheduler.notifyPlaybackExitOrSwitch();
    scheduler.notifyForeground(120_000);
    scheduler.notifyReconnect();
    await scheduler.flushBeforeBackground(100);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(syncPush).not.toHaveBeenCalled();
    expect(syncPull).not.toHaveBeenCalled();

    signedIn = true;
    scheduler.notifyMutation();
    scheduler.setViewingActive(true);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(syncPush).not.toHaveBeenCalled();
    expect(syncPull).not.toHaveBeenCalled();
    unsub();
  });

  it('P1-8: reset() cancels all pending timers, resets failure/dirty/viewing state to idle, ignores stale in-flight settlement, and stays reusable', async () => {
    let signedIn = true;
    const inFlightReject: { fn: ((err: Error) => void) | null } = { fn: null };
    const syncPush = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          inFlightReject.fn = reject;
        }),
    );
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => signedIn,
    });

    scheduler.setViewingActive(true);
    scheduler.notifyMutation();
    scheduler.notifyPlaybackPause();
    // Kick off an in-flight push via exit
    scheduler.notifyPlaybackExitOrSwitch();
    expect(scheduler.getStatus().state).toBe('syncing');
    expect(syncPush).toHaveBeenCalledTimes(1);

    // User signs out -> reset() clears all timers, dirty flag, viewing heartbeat, and returns to idle
    signedIn = false;
    scheduler.reset();
    expect(scheduler.getStatus()).toEqual({
      state: 'idle',
      dirty: false,
      inFlight: false,
      consecutiveFailures: 0,
      lastSyncedAt: null,
      lastErrorAt: null,
    });

    // Stale in-flight failure arriving after reset() MUST NOT dirty state or schedule retries
    inFlightReject.fn?.(new Error('stale-offline'));
    await vi.advanceTimersByTimeAsync(300_000);
    expect(syncPush).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().state).toBe('idle');
    expect(scheduler.getStatus().consecutiveFailures).toBe(0);

    // Signing back in reuses the same scheduler cleanly (reset != dispose)
    signedIn = true;
    syncPush.mockImplementation(async () => undefined);
    scheduler.notifyMutation();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(syncPush).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus().state).toBe('idle');

    scheduler.dispose();
  });

  it('P1-9: flushBeforeBackground awaits an already in-flight push covering mutationSeq without double-pushing, but still queues newer mid-flight mutations', async () => {
    const resolvers: Array<() => void> = [];
    const syncPush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const syncPull = vi.fn(async () => undefined);
    const scheduler = createAutoSyncScheduler({
      syncPush,
      syncPull,
      isSignedIn: () => true,
    });

    // Start push #1 covering mutationSeq = 1
    scheduler.notifyPlaybackExitOrSwitch();
    expect(syncPush).toHaveBeenCalledTimes(1);

    // Call flushBeforeBackground with NO new mutations -> MUST NOT schedule redundant push #2
    let flushed1 = false;
    const f1 = scheduler.flushBeforeBackground(5_000).then(() => {
      flushed1 = true;
    });
    expect(flushed1).toBe(false);
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await f1;
    expect(flushed1).toBe(true);
    expect(syncPush).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().dirty).toBe(false);

    // Now start push #2 covering mutationSeq = 2, then mutate mid-flight (mutationSeq = 3)
    scheduler.notifyPlaybackExitOrSwitch();
    expect(syncPush).toHaveBeenCalledTimes(2);
    scheduler.markDirty();

    const f2 = scheduler.flushBeforeBackground(5_000);
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    // Mid-flight mutation MUST trigger push #3
    expect(syncPush).toHaveBeenCalledTimes(3);
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    await f2;
    expect(scheduler.getStatus().dirty).toBe(false);

    scheduler.dispose();
  });
});

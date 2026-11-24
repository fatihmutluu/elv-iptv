import { describe, expect, it, vi } from 'vitest';
import { createPlaybackService } from './service';
import { clampSyncDelayMs, MAX_SYNC_DELAY_MS, MIN_SYNC_DELAY_MS } from './sync-delay';
import { createFakePlayerEngine } from './testing/fake-engine';
import type { PlaybackState, TuneRequest } from './types';

function makeHarness() {
  let now = 1_000;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const schedule = (fn: () => void, ms: number): number => {
    const id = nextTimerId++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const cancel = (handle: unknown): void => {
    if (typeof handle === 'number') timers.delete(handle);
  };
  const flushTimers = (advanceMs = 0): void => {
    now += advanceMs;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
  };
  const engine = createFakePlayerEngine({
    now: () => now,
    schedule,
    cancel,
    capabilities: {
      audioDelay: true,
      subtitleDelay: true,
      videoQualitySelection: true,
    },
  });
  const service = createPlaybackService({
    engine,
    clock: { now: () => now },
    timers: { setTimeout: schedule, clearTimeout: cancel },
  });
  return { engine, service, flushTimers };
}

function makeRequest(item = 'ch:1', url = 'http://sim/live/demo/demo/1.m3u8'): TuneRequest {
  return {
    item,
    accountKey: 'acct-1',
    kind: 'live',
    resolve: async () => ({ ok: true, value: { url, headers: {} } }),
  };
}

describe('clampSyncDelayMs', () => {
  it('clamps finite values to [-30_000, 30_000] and rounds to integer ms', () => {
    expect(clampSyncDelayMs(0)).toBe(0);
    expect(clampSyncDelayMs(-0)).toBe(0);
    expect(clampSyncDelayMs(150.4)).toBe(150);
    expect(clampSyncDelayMs(-150.6)).toBe(-151);
    expect(clampSyncDelayMs(45_000)).toBe(MAX_SYNC_DELAY_MS);
    expect(clampSyncDelayMs(-45_000)).toBe(MIN_SYNC_DELAY_MS);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(clampSyncDelayMs(Number.NaN)).toBe(0);
    expect(clampSyncDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampSyncDelayMs(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('PlaybackService sync delay, video quality, and secondary subtitle (#59, #239)', () => {
  it('sets, clamps, and resets audioDelayMs and subtitleDelayMs across tune/stop', async () => {
    const { engine, service, flushTimers } = makeHarness();
    const seen: PlaybackState[] = [];
    service.subscribe((st) => seen.push(st));

    // Ignored while idle
    service.setAudioDelay(250);
    service.setSubtitleDelay(-100);
    expect(service.getState().audioDelayMs).toBe(0);
    expect(service.getState().subtitleDelayMs).toBe(0);

    service.tune(makeRequest('ch:1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    flushTimers(300);

    service.setAudioDelay(50_000);
    expect(service.getState().audioDelayMs).toBe(30_000);
    service.setAudioDelay(-50_000);
    expect(service.getState().audioDelayMs).toBe(-30_000);
    service.setAudioDelay(Number.NaN);
    service.setAudioDelay(Number.POSITIVE_INFINITY);
    expect(service.getState().audioDelayMs).toBe(-30_000);

    service.setSubtitleDelay(175.4);
    expect(service.getState().subtitleDelayMs).toBe(175);
    service.setSubtitleDelay(Number.NEGATIVE_INFINITY);
    expect(service.getState().subtitleDelayMs).toBe(175);

    expect(engine.commands.filter((c) => c.name === 'setAudioDelay')).toEqual([
      { name: 'setAudioDelay', attempt: 1, delayMs: 30_000 },
      { name: 'setAudioDelay', attempt: 1, delayMs: -30_000 },
    ]);
    expect(engine.commands.filter((c) => c.name === 'setSubtitleDelay')).toEqual([
      { name: 'setSubtitleDelay', attempt: 1, delayMs: 175 },
    ]);
    expect(seen.some((s) => s.audioDelayMs === 30_000)).toBe(true);
    expect(seen.some((s) => s.subtitleDelayMs === 175)).toBe(true);

    // Resets on tune()
    service.tune(makeRequest('ch:2', 'http://sim/live/demo/demo/2.m3u8'));
    expect(service.getState().audioDelayMs).toBe(0);
    expect(service.getState().subtitleDelayMs).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    flushTimers(300);

    // Resets on adoptQueuedTarget()
    service.setAudioDelay(200);
    service.setSubtitleDelay(-50);
    service.adoptQueuedTarget(makeRequest('ep:2', 'http://sim/vod/ep2.mp4'));
    expect(service.getState().audioDelayMs).toBe(0);
    expect(service.getState().subtitleDelayMs).toBe(0);

    // Resets on stop()
    service.setAudioDelay(100);
    service.setSubtitleDelay(50);
    service.stop();
    expect(service.getState().audioDelayMs).toBe(0);
    expect(service.getState().subtitleDelayMs).toBe(0);
  });

  it('selects video quality and secondary subtitle tracks and syncs from engine tracks events', async () => {
    const { engine, service, flushTimers } = makeHarness();
    const onState = vi.fn();
    service.subscribe(onState);

    service.selectVideoQuality('1080p');
    service.selectSecondarySubtitleTrack('sub:2');
    expect(service.getState().selectedVideoQualityId).toBeNull();
    expect(engine.commands).toEqual([]);

    service.tune(makeRequest('ch:1'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    flushTimers(300);

    engine.emit({
      attempt: 1,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:1', language: 'en' }],
        subtitles: [
          { id: 's:1', language: 'en' },
          { id: 's:2', language: 'tr' },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
        selectedSecondarySubtitleId: null,
        videoQualities: [
          {
            id: 'v:1080',
            label: '1080p',
            width: 1920,
            height: 1080,
            bitrateBps: 5_000_000,
            fps: 50,
          },
          { id: 'v:720', label: '720p', width: 1280, height: 720, bitrateBps: 2_500_000, fps: 25 },
        ],
        selectedVideoQualityId: null,
      },
    });
    expect(service.getState().tracks.videoQualities).toHaveLength(2);
    expect(service.getState().selectedVideoQualityId).toBeNull();

    service.selectVideoQuality('v:720');
    expect(service.getState().selectedVideoQualityId).toBe('v:720');
    service.selectVideoQuality('   ');
    expect(service.getState().selectedVideoQualityId).toBeNull();

    service.selectSecondarySubtitleTrack('s:2');
    service.selectSecondarySubtitleTrack('');

    expect(engine.commands.filter((c) => c.name === 'selectVideoQuality')).toEqual([
      { name: 'selectVideoQuality', attempt: 1, qualityId: 'v:720' },
      { name: 'selectVideoQuality', attempt: 1, qualityId: null },
    ]);
    expect(engine.commands.filter((c) => c.name === 'selectSecondarySubtitleTrack')).toEqual([
      { name: 'selectSecondarySubtitleTrack', attempt: 1, trackId: 's:2' },
      { name: 'selectSecondarySubtitleTrack', attempt: 1, trackId: null },
    ]);

    service.stop();
    expect(service.getState().selectedVideoQualityId).toBeNull();
  });

  it('re-applies audioDelayMs, subtitleDelayMs, and selectedVideoQualityId set while tuning/held and across recovery reload', async () => {
    const { engine, service, flushTimers } = makeHarness();
    let resolveStream!: (res: {
      ok: true;
      value: { url: string; headers: Record<string, string> };
    }) => void;
    const req: TuneRequest = {
      item: 'ch:held',
      accountKey: 'acct-1',
      kind: 'live',
      resolve: () =>
        new Promise((r) => {
          resolveStream = r;
        }),
    };

    service.tune(req);
    expect(service.getState().status.kind).toBe('tuning');

    // Set delays and quality while still resolving (before engine.load is called)
    service.setAudioDelay(250);
    service.setSubtitleDelay(-150);
    service.selectVideoQuality('v:1080');
    expect(engine.commands).toEqual([]);

    // Now resolve the stream -> sendLoad() should push load + saved delays/quality to the engine
    resolveStream({ ok: true, value: { url: 'http://sim/live/demo/demo/held.m3u8', headers: {} } });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    flushTimers(0);

    const loadIdx = engine.commands.findIndex((c) => c.name === 'load' && c.attempt === 1);
    expect(loadIdx).toBeGreaterThanOrEqual(0);
    const afterLoad1 = engine.commands.slice(loadIdx + 1);
    expect(afterLoad1).toContainEqual({ name: 'setAudioDelay', attempt: 1, delayMs: 250 });
    expect(afterLoad1).toContainEqual({ name: 'setSubtitleDelay', attempt: 1, delayMs: -150 });
    expect(afterLoad1).toContainEqual({
      name: 'selectVideoQuality',
      attempt: 1,
      qualityId: 'v:1080',
    });

    // Simulate playing then transient error triggering recovery reload (sendLoad on new attempt)
    engine.emit({ attempt: 1, type: 'state', state: 'playing' });
    const countBeforeError = engine.commands.length;
    engine.emit({
      attempt: 1,
      type: 'error',
      error: { code: 'network', detail: 'stall' },
    });
    // Advance past recovery backoff so recovery triggers control.load()
    flushTimers(5_000);

    const recoveryCommands = engine.commands.slice(countBeforeError);
    const recoveryLoadIdx = recoveryCommands.findIndex((c) => c.name === 'load');
    expect(recoveryLoadIdx).toBeGreaterThanOrEqual(0);
    const recoveryAttempt = recoveryCommands[recoveryLoadIdx]?.attempt;
    const afterRecoveryLoad = recoveryCommands.slice(recoveryLoadIdx + 1);
    expect(afterRecoveryLoad).toContainEqual({
      name: 'setAudioDelay',
      attempt: recoveryAttempt,
      delayMs: 250,
    });
    expect(afterRecoveryLoad).toContainEqual({
      name: 'setSubtitleDelay',
      attempt: recoveryAttempt,
      delayMs: -150,
    });
    expect(afterRecoveryLoad).toContainEqual({
      name: 'selectVideoQuality',
      attempt: recoveryAttempt,
      qualityId: 'v:1080',
    });
  });
});

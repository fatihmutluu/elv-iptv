import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('allowLegacyTls forwarding (#182)', () => {
  it('forwards allowLegacyTls: true from TuneRequest into LoadCommand.options', async () => {
    const engine = createFakePlayerEngine({
      scripts: {},
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const loadSpy = vi.spyOn(engine, 'load');
    const service = createPlaybackService({
      engine,
      clock: { now: () => Date.now() },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    service.tune({
      item: 'live-1',
      accountKey: 'src-legacy',
      kind: 'live',
      allowLegacyTls: true,
      resolve: () => Promise.resolve(ok({ url: 'https://legacy.example/1.ts', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(loadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://legacy.example/1.ts',
        options: expect.objectContaining({ allowLegacyTls: true }),
      }),
    );
    service.dispose();
  });

  it('omits allowLegacyTls when not set on TuneRequest', async () => {
    const engine = createFakePlayerEngine({
      scripts: {},
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const loadSpy = vi.spyOn(engine, 'load');
    const service = createPlaybackService({
      engine,
      clock: { now: () => Date.now() },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    service.tune({
      item: 'live-2',
      accountKey: 'src-modern',
      kind: 'live',
      resolve: () => Promise.resolve(ok({ url: 'https://modern.example/2.ts', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    const [cmd] = loadSpy.mock.calls[0] ?? [];
    expect(cmd?.options?.allowLegacyTls).toBeUndefined();
    service.dispose();
  });

  it('forwards StreamRequest.allowLegacyTls and preserves it across retry() and VOD replayFromZero()', async () => {
    const engine = createFakePlayerEngine({
      scripts: {},
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const loadSpy = vi.spyOn(engine, 'load');
    const service = createPlaybackService({
      engine,
      clock: { now: () => Date.now() },
      timers: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    });

    service.tune({
      item: 'vod-legacy',
      accountKey: 'src-legacy',
      kind: 'vod',
      startMs: 30_000,
      resolve: () =>
        Promise.resolve(
          ok({
            url: 'https://legacy.example/movie.mp4',
            headers: {},
            allowLegacyTls: true,
          }),
        ),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[0]?.[0]?.options?.allowLegacyTls).toBe(true);

    // Trigger ended state -> service.retry() calls replayFromZero() with startMs: 0
    const firstAttempt = service.getState().attempt;
    engine.emit({ attempt: firstAttempt, type: 'state', state: 'ended' });
    expect(service.getState().status.kind).toBe('ended');

    service.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadSpy).toHaveBeenCalledTimes(2);
    expect(loadSpy.mock.calls[1]?.[0]?.startMs).toBe(0);
    expect(loadSpy.mock.calls[1]?.[0]?.options?.allowLegacyTls).toBe(true);

    // Trigger terminal auth failure -> service.retry() re-tunes from failed state
    const secondAttempt = service.getState().attempt;
    engine.emit({
      attempt: secondAttempt,
      type: 'error',
      error: { code: 'http-401', httpStatus: 401 },
    });
    expect(service.getState().status.kind).toBe('failed');

    service.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadSpy).toHaveBeenCalledTimes(3);
    expect(loadSpy.mock.calls[2]?.[0]?.options?.allowLegacyTls).toBe(true);
    service.dispose();
  });
});

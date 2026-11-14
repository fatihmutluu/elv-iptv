import type { EngineEvent } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  centerRect,
  createVideoSampler,
  GATE_VIDEO_BUCKETS,
  mergeGateLine,
  parseGateFlag,
  sampleRect,
} from './gate.ts';

describe('parseGateFlag', () => {
  const query = 'elv-gate=player&base=http://127.0.0.1:7878&account=demo&zaps=5';

  it('returns the query of --elv-gate=<query>', () => {
    expect(parseGateFlag(['electron', '.', `--elv-gate=${query}`], false)).toBe(query);
  });

  it('ignores the flag in packaged builds', () => {
    expect(parseGateFlag(['app.exe', `--elv-gate=${query}`], true)).toBeNull();
  });

  it('returns null without the flag or with an empty or foreign query', () => {
    expect(parseGateFlag(['electron', '.'], false)).toBeNull();
    expect(parseGateFlag(['--elv-gate='], false)).toBeNull();
    expect(parseGateFlag(['--elv-gate=elv-gate=list'], false)).toBeNull();
    expect(parseGateFlag(['--elv-gate=account=demo'], false)).toBeNull();
  });

  it('refuses a query with control characters or an absurd length', () => {
    expect(parseGateFlag([`--elv-gate=${query}\nx`], false)).toBeNull();
    expect(parseGateFlag([`--elv-gate=${query}&x=${'a'.repeat(3000)}`], false)).toBeNull();
  });

  it('takes the first of several flags', () => {
    expect(parseGateFlag([`--elv-gate=${query}`, '--elv-gate=elv-gate=player&zaps=9'], false)).toBe(
      query,
    );
  });
});

describe('mergeGateLine', () => {
  const extras = {
    mpvSpawns: 1,
    loadMode: 'replace',
    presenter: 'child-window',
    videoVisible: true,
    distinct: 40,
    coalesceMaxMs: 512,
  };

  it('adds the main-side fields to the renderer line, in one line', () => {
    const merged = mergeGateLine('ELV_GATE_PLAYER {"zaps":5,"ttffColdMs":812}', extras);
    expect(merged?.startsWith('ELV_GATE_PLAYER {')).toBe(true);
    expect(merged).not.toContain('\n');
    expect(JSON.parse((merged ?? '').slice('ELV_GATE_PLAYER '.length))).toEqual({
      zaps: 5,
      ttffColdMs: 812,
      ...extras,
    });
  });

  it('main fields win over renderer fields of the same name', () => {
    const merged = mergeGateLine('ELV_GATE_PLAYER {"mpvSpawns":99}', extras);
    expect(merged).toContain('"mpvSpawns":1');
  });

  it('refuses a line that is not JSON, not an object, or carries a stream address', () => {
    expect(mergeGateLine('ELV_GATE_PLAYER {nope', extras)).toBeNull();
    expect(mergeGateLine('ELV_GATE_PLAYER [1]', extras)).toBeNull();
    expect(
      mergeGateLine('ELV_GATE_PLAYER {"x":"http://127.0.0.1:7878/live/a/a/1.ts"}', extras),
    ).toBeNull();
    expect(mergeGateLine('ELV_GATE_PLAYER {"x":"HTTPS://h"}', extras)).toBeNull();
    expect(mergeGateLine('other {"a":1}', extras)).toBeNull();
  });
});

describe('centerRect', () => {
  it('is the middle half of the content bounds', () => {
    expect(centerRect({ x: 100, y: 40, width: 1280, height: 720 })).toEqual({
      x: 420,
      y: 220,
      width: 640,
      height: 360,
    });
  });
});

describe('createVideoSampler', () => {
  function setup(distinct: number) {
    vi.useFakeTimers();
    const listeners = new Set<(e: EngineEvent) => void>();
    const sample = vi.fn(async () => ({ distinct }));
    const sampler = createVideoSampler({
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      sample,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      delayMs: 1000,
    });
    const frame = (attempt = 1) => {
      for (const l of [...listeners]) l({ attempt, type: 'firstFrame', atMs: 5 });
    };
    return { sampler, sample, frame, listeners };
  }

  it('samples once, 1000 ms after the first firstFrame', async () => {
    const t = setup(40);
    t.frame(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.sample).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    t.frame(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.sample).toHaveBeenCalledTimes(1);
    expect(await t.sampler.result()).toEqual({ videoVisible: true, distinct: 40 });
    vi.useRealTimers();
  });

  it('waits for the sample when the result is asked for early', async () => {
    const t = setup(GATE_VIDEO_BUCKETS);
    t.frame();
    let done = false;
    void t.sampler.result().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(done).toBe(true);
    vi.useRealTimers();
  });

  it('judges a uniform area as no video', async () => {
    const t = setup(GATE_VIDEO_BUCKETS - 1);
    t.frame();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await t.sampler.result()).toEqual({
      videoVisible: false,
      distinct: GATE_VIDEO_BUCKETS - 1,
    });
    vi.useRealTimers();
  });

  it('reports videoVisible null when the capture returned no image', async () => {
    const t = setup(0);
    t.frame();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await t.sampler.result()).toEqual({ videoVisible: null, distinct: 0 });
    vi.useRealTimers();
  });

  it('reports no video at once when no frame ever came', async () => {
    const t = setup(40);
    expect(await t.sampler.result()).toEqual({ videoVisible: false, distinct: 0 });
    expect(t.sample).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports null when the capture throws', async () => {
    const t = setup(40);
    t.sample.mockRejectedValueOnce(new Error('capture'));
    t.frame();
    await vi.advanceTimersByTimeAsync(1100);
    expect(await t.sampler.result()).toEqual({ videoVisible: null, distinct: 0 });
    vi.useRealTimers();
  });
});

describe('sampleRect', () => {
  const content = { x: 100, y: 40, width: 1280, height: 720 };
  const area = { x: 10, y: 20, width: 800, height: 450, visible: true };

  it('is the last area in screen DIPs, scaled by the page zoom', () => {
    expect(sampleRect(content, area, 1)).toEqual({ x: 110, y: 60, width: 800, height: 450 });
    expect(sampleRect(content, area, 1.5)).toEqual({ x: 115, y: 70, width: 1200, height: 675 });
  });

  it('falls back to the middle half without an area or with an empty one', () => {
    const middle = centerRect(content);
    expect(sampleRect(content, undefined, 1)).toEqual(middle);
    expect(sampleRect(content, { ...area, width: 0 }, 1)).toEqual(middle);
    expect(sampleRect(content, { ...area, visible: false }, 1)).toEqual(middle);
  });
});

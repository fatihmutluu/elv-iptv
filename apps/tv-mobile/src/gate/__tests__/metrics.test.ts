import { describe, expect, it } from 'vitest';
import { createRecorder, gateLine, summarize } from '../metrics';

describe('summarize', () => {
  it('uses nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
    const m = summarize(samples, [1, 7, 3], { moves: 100, coalesced: 2, losses: 1, items: 5 });
    expect(m).toEqual({
      moves: 100,
      coalesced: 2,
      losses: 1,
      keyToHighlightMs: { p50: 50, p95: 95, max: 100 },
      maxJsGapMs: 7,
      items: 5,
    });
  });

  it('handles tiny and empty inputs', () => {
    const counts = { moves: 0, coalesced: 0, losses: 0, items: 1 };
    expect(summarize([], [], counts).keyToHighlightMs).toEqual({ p50: 0, p95: 0, max: 0 });
    expect(summarize([], [], counts).maxJsGapMs).toBe(0);
    expect(summarize([12.3456], [], counts).keyToHighlightMs).toEqual({
      p50: 12.35,
      p95: 12.35,
      max: 12.35,
    });
  });

  it('does not mutate its input', () => {
    const samples = [3, 1, 2];
    summarize(samples, [], { moves: 3, coalesced: 0, losses: 0, items: 1 });
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe('gateLine', () => {
  it('prefixes the JSON with ELV_GATE', () => {
    const m = summarize([1], [2], { moves: 1, coalesced: 0, losses: 0, items: 9 });
    const line = gateLine(m);
    expect(line.startsWith('ELV_GATE {')).toBe(true);
    expect(JSON.parse(line.slice('ELV_GATE '.length))).toEqual(m);
    expect(line).not.toContain('\n');
  });
});

describe('createRecorder', () => {
  const geometry = { items: 1000 };
  const win = (start: number) => ({
    start,
    end: start + 10,
    renderedStart: start,
    renderedEnd: start + 14,
  });

  it('measures key-to-highlight for every pending move on a commit', () => {
    const r = createRecorder(geometry);
    r.move(10);
    r.move(20);
    r.commit(40, 2, 2, win(0));
    expect(r.pending()).toBe(0);
    const m = r.finish();
    expect(m.moves).toBe(2);
    expect(m.keyToHighlightMs).toEqual({ p50: 20, p95: 30, max: 30 });
    expect(m.losses).toBe(0);
  });

  it('counts coalesced repeats', () => {
    const r = createRecorder(geometry);
    r.coalesce();
    r.coalesce();
    expect(r.finish().coalesced).toBe(2);
  });

  it('measures the synchronous work from dispatch to the end of the commit', () => {
    const r = createRecorder(geometry);
    r.workStart(10);
    r.workStart(12);
    r.workEnd(31);
    r.workEnd(50);
    r.workStart(100);
    r.workEnd(104);
    expect(r.finish().maxJsGapMs).toBe(21);
  });

  it('reads a 30 ms stall as over the 16 ms budget, whatever frame it starts in', () => {
    const quiet = Array.from({ length: 30 }, () => 16.7);
    for (const delta of [30.1, 33.3, 40, 46.7]) {
      const r = createRecorder(geometry);
      for (const d of [...quiet, delta, ...quiet]) r.frameDelta(d);
      expect(r.finish().maxJsGapMs).toBeGreaterThanOrEqual(16);
    }
  });

  it('reads a 20 ms stall as over the budget when it starts late in a frame', () => {
    const quiet = Array.from({ length: 30 }, () => 16.7);
    const r = createRecorder(geometry);
    for (const d of [...quiet, 33.3, ...quiet]) r.frameDelta(d);
    expect(r.finish().maxJsGapMs).toBeGreaterThanOrEqual(16);
  });

  it('keeps idle vsync jitter below the budget', () => {
    const r = createRecorder(geometry);
    for (const d of [16.7, 12.9, 17.9, 22.5, 16.7, 27, 16.7, 16.6]) r.frameDelta(d);
    expect(r.finish().maxJsGapMs).toBeLessThan(16);
  });

  it('reports the larger of the commit work and the frame stall, and resets per run', () => {
    const r = createRecorder(geometry);
    for (const d of [16, 16, 16, 30]) r.frameDelta(d);
    r.workStart(0);
    r.workEnd(9);
    expect(r.finish().maxJsGapMs).toBe(18.8);
    const w = createRecorder(geometry);
    w.workStart(0);
    w.workEnd(9);
    expect(w.finish().maxJsGapMs).toBe(9);
    expect(w.finish().maxJsGapMs).toBe(0);
  });

  it('counts a settled frame that shows a stale index and moves that never committed as losses', () => {
    const stale = createRecorder(geometry);
    stale.move(0);
    stale.commit(5, 3, 4, win(0));
    expect(stale.finish().losses).toBe(1);

    const open = createRecorder(geometry);
    open.move(0);
    open.move(1);
    expect(open.finish().losses).toBe(2);
  });

  it('counts a committed index outside the list as a loss', () => {
    const r = createRecorder(geometry);
    r.move(0);
    r.commit(5, 5000, 5000, win(4990));
    expect(r.finish().losses).toBe(1);
  });

  it('counts a focused index outside the visible or rendered rows as a loss', () => {
    const hidden = createRecorder(geometry);
    hidden.move(0);
    hidden.commit(5, 20, 20, win(0));
    expect(hidden.finish().losses).toBe(1);

    const unrendered = createRecorder(geometry);
    unrendered.move(0);
    unrendered.commit(5, 12, 12, { start: 5, end: 15, renderedStart: 5, renderedEnd: 12 });
    expect(unrendered.finish().losses).toBe(1);
  });

  it('resolves pending moves whose net effect left the index unchanged', () => {
    const r = createRecorder(geometry);
    r.workStart(0);
    r.move(0);
    r.move(4);
    r.resolve(10);
    expect(r.pending()).toBe(0);
    const m = r.finish();
    expect(m.losses).toBe(0);
    expect(m.keyToHighlightMs.max).toBe(10);
  });

  it('drops a dispatch time that no commit will close', () => {
    const r = createRecorder(geometry);
    r.workStart(0);
    r.move(0);
    r.resolve(10);
    r.workStart(20);
    r.workEnd(23);
    expect(r.finish().maxJsGapMs).toBe(3);
  });

  it('resets after finish', () => {
    const r = createRecorder(geometry);
    r.move(0);
    r.commit(5, 1, 1, win(0));
    r.finish();
    expect(r.finish().moves).toBe(0);
  });
});

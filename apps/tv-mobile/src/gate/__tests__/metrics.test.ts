import { describe, expect, it } from 'vitest';
import { createRecorder, gateLine, summarize } from '../metrics';

describe('summarize', () => {
  it('uses nearest-rank percentiles', () => {
    const samples = Array.from({ length: 100 }, (_, i) => 100 - i);
    const m = summarize(
      samples,
      [1, 7, 3],
      { moves: 100, scripted: 104, coalesced: 2, losses: 1, items: 5 },
      12.345,
    );
    expect(m).toEqual({
      moves: 100,
      scripted: 104,
      coalesced: 2,
      losses: 1,
      intents: { select: 0, long: 0, back: 0, backLong: 0, edge: 0, key: 0 },
      keyToHighlightMs: { p50: 50, p95: 95, max: 100 },
      maxJsGapMs: 7,
      maxFrameStallMs: 12.35,
      items: 5,
    });
  });

  it('handles tiny and empty inputs', () => {
    const counts = { moves: 0, scripted: 0, coalesced: 0, losses: 0, items: 1 };
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
    summarize(samples, [], { moves: 3, scripted: 3, coalesced: 0, losses: 0, items: 1 });
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe('gateLine', () => {
  it('prefixes the JSON with ELV_GATE', () => {
    const m = summarize([1], [2], { moves: 1, scripted: 1, coalesced: 0, losses: 0, items: 9 });
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

  it('counts intents and reports all six kinds, zeros included', () => {
    const r = createRecorder(geometry);
    r.intent('select');
    r.intent('long');
    r.intent('long');
    expect(r.finish().intents).toEqual({
      select: 1,
      long: 2,
      back: 0,
      backLong: 0,
      edge: 0,
      key: 0,
    });
    expect(r.finish().intents).toEqual({
      select: 0,
      long: 0,
      back: 0,
      backLong: 0,
      edge: 0,
      key: 0,
    });
  });

  it('counts coalesced repeats', () => {
    const r = createRecorder(geometry);
    r.coalesce();
    r.coalesce();
    expect(r.finish().coalesced).toBe(2);
  });

  it('counts every scripted driver event, whether it moved, was coalesced or hit an edge', () => {
    const r = createRecorder(geometry);
    for (let i = 0; i < 3; i++) r.scripted();
    r.move(0);
    r.coalesce();
    r.commit(5, 1, 1, win(0));
    const m = r.finish();
    expect(m).toMatchObject({ scripted: 3, moves: 1, coalesced: 1 });
    expect(r.finish().scripted).toBe(0);
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

  it('reads a 30 ms stall as a frame stall over 16 ms, whatever frame it starts in', () => {
    const quiet = Array.from({ length: 30 }, () => 16.7);
    for (const delta of [30.1, 33.3, 40, 46.7]) {
      const r = createRecorder(geometry);
      for (const d of [...quiet, delta, ...quiet]) r.frameDelta(d);
      expect(r.finish().maxFrameStallMs).toBeGreaterThanOrEqual(16);
    }
  });

  it('does not claim to detect a 20 ms stall: its delay is hard to tell from vsync slips', () => {
    const quiet = Array.from({ length: 30 }, () => 16.7);
    const measured = createRecorder(geometry);
    for (const d of [...quiet, 22.9, ...quiet]) measured.frameDelta(d);
    expect(measured.finish().maxFrameStallMs).toBeLessThan(16);
    const lateInFrame = createRecorder(geometry);
    for (const d of [...quiet, 33.3, ...quiet]) lateInFrame.frameDelta(d);
    expect(lateInFrame.finish().maxFrameStallMs).toBeGreaterThanOrEqual(16);
  });

  it('keeps idle vsync jitter below 16 ms', () => {
    const r = createRecorder(geometry);
    for (const d of [16.7, 12.9, 17.9, 22.5, 16.7, 27, 16.7, 16.6]) r.frameDelta(d);
    expect(r.finish().maxFrameStallMs).toBeLessThan(16);
  });

  it('keeps the frame stall out of the JS gap, and resets per run', () => {
    const r = createRecorder(geometry);
    for (const d of [16, 16, 16, 30]) r.frameDelta(d);
    r.workStart(0);
    r.workEnd(9);
    const m = r.finish();
    expect(m.maxJsGapMs).toBe(9);
    expect(m.maxFrameStallMs).toBe(18.8);
    const again = r.finish();
    expect(again.maxJsGapMs).toBe(0);
    expect(again.maxFrameStallMs).toBe(0);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, LoadCommand } from '../engine';
import { createFakePlayerEngine, type FakeEngineOptions, type FakeStep } from './fake-engine';

function load(url: string, attempt = 1): LoadCommand {
  return { url, headers: {}, attempt, kind: 'live' };
}

function setup(
  scripts?: Record<string, readonly FakeStep[]>,
  extra: Partial<FakeEngineOptions> = {},
) {
  const engine = createFakePlayerEngine({
    ...(scripts ? { scripts } : {}),
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...extra,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

describe('FakePlayerEngine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays the default script for an unknown URL', () => {
    const { engine, events } = setup();
    engine.load(load('http://x/a'));
    vi.advanceTimersByTime(0);
    expect(events).toEqual([{ attempt: 1, type: 'state', state: 'opening' }]);
    vi.advanceTimersByTime(299);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(events.map((e) => e.type)).toEqual(['state', 'firstFrame', 'state']);
    expect(events[2]).toEqual({ attempt: 1, type: 'state', state: 'playing' });
  });

  it('tags a scripted error with the token of the last command', () => {
    const { engine, events } = setup({
      'http://x/a': [{ afterMs: 2000, emit: 'error', error: { code: 'network' } }],
    });
    engine.load(load('http://x/a', 3));
    engine.retry(7);
    vi.advanceTimersByTime(2000);
    expect(events).toEqual([{ attempt: 7, type: 'error', error: { code: 'network' } }]);
    expect(engine.commands.map((c) => c.name)).toEqual(['load', 'retry']);
  });

  it('does not adopt an older token', () => {
    const { engine, events } = setup({ u: [{ afterMs: 10, emit: 'firstFrame' }] });
    engine.load(load('u', 5));
    engine.pause(2);
    vi.advanceTimersByTime(10);
    expect(events[0]?.attempt).toBe(5);
  });

  it('runs every step kind', () => {
    const { engine, events } = setup({
      u: [
        { afterMs: 1, emit: 'state', state: 'buffering' },
        { afterMs: 2, emit: 'clock', positionMs: 500 },
        { afterMs: 3, emit: 'clock', positionMs: 900, rate: 2 },
        { afterMs: 4, emit: 'stall', phase: 'start' },
        { afterMs: 5, emit: 'stall', phase: 'end' },
      ],
    });
    engine.load(load('u'));
    vi.advanceTimersByTime(5);
    expect(events.map((e) => e.type)).toEqual(['state', 'clock', 'clock', 'stall', 'stall']);
    const clock = events[1];
    expect(clock).toMatchObject({ type: 'clock', anchor: { positionMs: 500, rate: 1 } });
    expect(events[2]).toMatchObject({ anchor: { positionMs: 900, rate: 2 } });
    expect(events[3]).toMatchObject({ type: 'stall', phase: 'start' });
  });

  it('replaces the media on load and keeps one open', () => {
    const { engine, events } = setup({ a: [{ afterMs: 100, emit: 'firstFrame' }] });
    engine.load(load('a', 1));
    engine.load(load('b', 2));
    expect(engine.openMedias()).toBe(1);
    expect(engine.maxConcurrentMedias()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(events.every((e) => e.attempt === 2)).toBe(true);
    expect(events.find((e) => e.type === 'firstFrame')).toBeUndefined();
  });

  it('re-runs the script on retry', () => {
    const { engine, events } = setup({ u: [{ afterMs: 5, emit: 'firstFrame' }] });
    engine.load(load('u', 1));
    vi.advanceTimersByTime(5);
    engine.retry(2);
    vi.advanceTimersByTime(5);
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
    expect(engine.openMedias()).toBe(1);
  });

  it('leaves the engine idle after recreate until a load or retry', () => {
    const { engine, events } = setup({ u: [{ afterMs: 5, emit: 'firstFrame' }] });
    engine.load(load('u', 1));
    engine.recreate(2);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    engine.retry(3);
    vi.advanceTimersByTime(5);
    engine.recreate(4);
    engine.load(load('u', 5));
    vi.advanceTimersByTime(5);
    expect(events.map((e) => e.attempt)).toEqual([3, 5]);
    expect(engine.openMedias()).toBe(1);
  });

  it('retry before any load does nothing', () => {
    const { engine, events } = setup();
    engine.retry(1);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    expect(engine.openMedias()).toBe(0);
  });

  it('records play, pause and seek without scripting', () => {
    const { engine, events } = setup({ u: [] });
    engine.load(load('u', 1));
    engine.play(2);
    engine.pause(3);
    engine.seek(4, 1234);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    expect(engine.commands.map((c) => c.name)).toEqual(['load', 'play', 'pause', 'seek']);
  });

  it('anchors the clock on play and pause when anchorOnPlayPause is set', () => {
    const { engine, events } = setup({ u: [] }, { anchorOnPlayPause: true });
    engine.load(load('u', 1));
    engine.play(2);
    engine.pause(3);
    engine.seek(4, 1234);
    vi.advanceTimersByTime(1000);
    expect(events.map((e) => e.type === 'clock' && [e.attempt, e.anchor.rate])).toEqual([
      [4, 1],
      [4, 0],
    ]);
    expect(engine.commands.map((c) => c.name)).toEqual(['load', 'play', 'pause', 'seek']);
    expect(engine.commands[0]).toMatchObject({ attempt: 1, url: 'u' });
    expect(engine.commands[3]).toEqual({ name: 'seek', attempt: 4, positionMs: 1234 });
  });

  it('a pause anchors where the latest clock anchor has moved to by then', () => {
    const { engine, events } = setup({ u: [] }, { anchorOnPlayPause: true });
    engine.load(load('u', 1));
    engine.emit({
      attempt: 1,
      type: 'clock',
      anchor: { positionMs: 30_000, atMs: Date.now(), rate: 1 },
    });
    vi.advanceTimersByTime(500);
    engine.pause(2);
    vi.advanceTimersByTime(0);
    expect(events.at(-1)).toMatchObject({
      attempt: 2,
      type: 'clock',
      anchor: { positionMs: 30_500, rate: 0 },
    });
  });

  it('a failed media anchors nothing on play or pause', () => {
    const { engine, events } = setup({ u: [] }, { anchorOnPlayPause: true });
    engine.load(load('u', 1));
    engine.emit({ attempt: 1, type: 'error', error: { code: 'network' } });
    engine.pause(2);
    engine.play(3);
    vi.advanceTimersByTime(10);
    expect(events.filter((e) => e.type === 'clock')).toEqual([]);
  });

  it('stop ends the media and cancels pending steps', () => {
    const { engine, events } = setup();
    engine.load(load('u'));
    engine.stop(2);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    expect(engine.openMedias()).toBe(0);
  });

  it('emit delivers a stale token unchanged and surface emits a surface event', () => {
    const { engine, events } = setup();
    engine.load(load('u', 9));
    engine.emit({ attempt: 1, type: 'stall', phase: 'start', atMs: 0 });
    engine.surface('destroyed');
    expect(events[0]).toMatchObject({ attempt: 1, type: 'stall' });
    expect(events[1]).toEqual({ attempt: 9, type: 'surface', change: 'destroyed' });
  });

  it('release stops scripts and unsubscribes listeners', () => {
    const { engine, events } = setup();
    const extra: EngineEvent[] = [];
    const off = engine.subscribe((e) => extra.push(e));
    engine.load(load('u'));
    engine.release();
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
    engine.emit({ attempt: 1, type: 'firstFrame', atMs: 0 });
    expect(events).toEqual([]);
    expect(engine.openMedias()).toBe(0);
    off();
  });

  it('unsubscribe stops delivery', () => {
    const { engine } = setup();
    const got: EngineEvent[] = [];
    const off = engine.subscribe((e) => got.push(e));
    off();
    engine.emit({ attempt: 1, type: 'firstFrame', atMs: 0 });
    expect(got).toEqual([]);
  });

  it('has default capabilities and allows overrides', () => {
    expect(setup().engine.capabilities).toMatchObject({ hls: true, softwareAudioFallback: false });
    const { engine } = setup(undefined, { capabilities: { hls: false } });
    expect(engine.capabilities.hls).toBe(false);
    expect(engine.capabilities.recreate).toBe(true);
  });
});

import type { PlaybackTimers } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import { createZapController, ZAP_COALESCE_MS } from './zap-controller';

function createTimers() {
  let now = 0;
  const tasks = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const timers: PlaybackTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      tasks.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => {
      tasks.delete(handle as number);
    },
  };
  return {
    timers,
    pending: () => tasks.size,
    advance(ms: number): void {
      now += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at <= now) {
          tasks.delete(id);
          task.fn();
        }
      }
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function entry(i: number): PlayableEntry {
  return { itemKey: `ch-${i}`, sourceId: 'src', title: `Channel ${i}`, kind: 'live' };
}

function setup(
  options: { count?: number; getAt?: (i: number) => Promise<PlayableEntry | undefined> } = {},
) {
  const fake = createTimers();
  const onChangeIndex = vi.fn();
  let current: PlayTarget = {
    ...entry(0),
    playlist: {
      count: options.count ?? 3,
      currentIndex: 0,
      onChangeIndex,
      getAt: options.getAt ?? (async (i) => entry(i)),
    },
  };
  const shown: { target: PlayTarget; index: number }[] = [];
  const tuned: string[] = [];
  const controller = createZapController({
    timers: () => fake.timers,
    current: () => current,
    show: (next, index) => {
      current = next;
      shown.push({ target: next, index });
    },
    tune: (target) => {
      tuned.push(target.itemKey);
    },
  });
  return {
    fake,
    controller,
    shown,
    tuned,
    setCurrent(next: PlayTarget) {
      current = next;
    },
  };
}

describe('createZapController', () => {
  it('tunes an isolated press at once and wraps around the playlist', async () => {
    const s = setup();
    s.controller.zap(-1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([2]);
    expect(s.shown[0]?.target).toMatchObject({ itemKey: 'ch-2', title: 'Channel 2' });
    expect(s.shown[0]?.target.playlist?.currentIndex).toBe(2);
    expect(s.tuned).toEqual(['ch-2']);
    expect(s.fake.pending()).toBe(0);

    s.controller.zap(1);
    await flush();
    expect(s.tuned).toEqual(['ch-2', 'ch-0']);
  });

  it('steps rapid presses from the pending cursor and drops superseded lookups', async () => {
    let hold: ((e: PlayableEntry | undefined) => void) | undefined;
    const s = setup({
      getAt: (i) =>
        i === 1
          ? new Promise((resolve) => {
              hold = resolve;
            })
          : Promise.resolve(entry(i)),
    });
    s.controller.zap(1);
    s.controller.zap(1);
    await flush();
    hold?.(entry(1));
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([2]);
    expect(s.tuned).toEqual(['ch-2']);
  });

  it('coalesces held repeats into one deferred tune while showing every title at once', async () => {
    const s = setup({ count: 5 });
    s.controller.zap(1, true);
    await flush();
    expect(s.shown.map((x) => x.target.title)).toEqual(['Channel 1']);
    expect(s.tuned).toEqual([]);

    s.fake.advance(ZAP_COALESCE_MS - 50);
    s.controller.zap(1, true);
    await flush();
    s.controller.zap(1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([1, 2, 3]);
    s.fake.advance(ZAP_COALESCE_MS - 1);
    expect(s.tuned).toEqual([]);
    s.fake.advance(1);
    expect(s.tuned).toEqual(['ch-3']);

    s.controller.zap(1);
    await flush();
    expect(s.tuned).toEqual(['ch-3', 'ch-4']);
  });

  it('reverts the cursor to the committed index when a lookup misses or rejects', async () => {
    const failedOnce = new Set<number>();
    const s = setup({
      count: 4,
      getAt: (i) => {
        if (failedOnce.has(i) || (i !== 1 && i !== 3)) return Promise.resolve(entry(i));
        failedOnce.add(i);
        return i === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('boom'));
      },
    });
    s.controller.zap(1);
    await flush();
    expect(s.shown).toEqual([]);
    s.controller.zap(1);
    await flush();
    s.controller.zap(1);
    await flush();
    s.controller.zap(1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([1, 2]);
    s.controller.zap(1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([1, 2, 3]);
  });

  it('reset and dispose cancel deferred tunes and in-flight lookups', async () => {
    const s = setup();
    s.controller.zap(1, true);
    await flush();
    s.controller.reset(0);
    s.fake.advance(ZAP_COALESCE_MS);
    expect(s.tuned).toEqual([]);

    s.controller.zap(1);
    s.controller.reset(0);
    await flush();
    expect(s.shown).toHaveLength(1);

    s.controller.zap(1);
    s.controller.dispose();
    await flush();
    expect(s.shown).toHaveLength(1);
    expect(s.tuned).toEqual([]);
  });

  it('hands a deferred tune back to the caller via takePendingTune', async () => {
    const s = setup();
    expect(s.controller.takePendingTune()).toBe(false);
    s.controller.zap(1, true);
    await flush();
    expect(s.controller.takePendingTune()).toBe(true);
    s.fake.advance(ZAP_COALESCE_MS);
    expect(s.tuned).toEqual([]);
  });

  it('syncs the committed index without disturbing an in-flight zap', async () => {
    let hold: ((e: PlayableEntry | undefined) => void) | undefined;
    const s = setup({
      count: 10,
      getAt: (i) =>
        i === 6
          ? new Promise((resolve) => {
              hold = resolve;
            })
          : Promise.resolve(entry(i)),
    });
    s.controller.sync(4);
    s.controller.zap(1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([5]);

    s.controller.zap(1);
    s.controller.sync(5);
    hold?.(entry(6));
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([5, 6]);

    s.controller.sync(8);
    s.controller.zap(1);
    await flush();
    expect(s.shown.map((x) => x.index)).toEqual([5, 6, 9]);
  });

  it('ignores zaps for VOD targets or empty playlists', async () => {
    const s = setup();
    s.setCurrent({ ...entry(0), kind: 'vod' });
    s.controller.zap(1);
    s.setCurrent(entry(0));
    s.controller.zap(1);
    s.setCurrent({
      ...entry(0),
      playlist: { count: 0, currentIndex: 0, onChangeIndex: vi.fn(), getAt: async () => entry(1) },
    });
    s.controller.zap(1);
    await flush();
    expect(s.shown).toEqual([]);
  });

  it('waits for an in-flight repeat lookup when the coalesce window expires first, and flushes an earlier repeat if a trailing lookup fails', async () => {
    let holdSlow: ((e: PlayableEntry | undefined) => void) | undefined;
    const s = setup({
      count: 5,
      getAt: (i) => {
        if (i === 1) {
          return new Promise((resolve) => {
            holdSlow = resolve;
          });
        }
        if (i === 3) return Promise.resolve(undefined);
        return Promise.resolve(entry(i));
      },
    });
    s.controller.zap(1, true);
    s.fake.advance(ZAP_COALESCE_MS);
    expect(s.tuned).toEqual([]);
    holdSlow?.(entry(1));
    await flush();
    expect(s.tuned).toEqual(['ch-1']);

    s.controller.zap(1, true);
    await flush();
    expect(s.shown.at(-1)?.index).toBe(2);
    s.controller.zap(1, true);
    s.fake.advance(ZAP_COALESCE_MS);
    await flush();
    expect(s.tuned).toEqual(['ch-1', 'ch-2']);
  });
});

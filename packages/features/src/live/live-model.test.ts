import type { ItemRow, ProgrammeRow } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import {
  appendNumberDigit,
  buildEpgRulerTicks,
  buildLiveHubPlayTarget,
  computeNowLineRatio,
  computeProgramProgress,
  createBoundedTtlCache,
  createStaticPagedListSource,
  EMPTY_LIVE_MEMORY,
  EPG_SLOT_MS,
  EPG_VISIBLE_SPAN_MS,
  findProgramIndexAtTime,
  floorToEpgSlot,
  formatClockTime,
  formatLiveTitle,
  indexNowNext,
  layoutEpgSlots,
  parseNumberBuffer,
  recordChannelTune,
} from './live-model';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 10, 21, 18, 0, 0);

const makeProg = (
  startOffsetMin: number,
  stopOffsetMin: number,
  title: string,
  channelKey = 'x:s1:live:1',
): ProgrammeRow => ({
  channelKey,
  sourceId: 's1',
  guideId: 'g1',
  start: BASE + startOffsetMin * 60_000,
  stop: BASE + stopOffsetMin * 60_000,
  title,
  subTitle: null,
  description: null,
  episodeNum: null,
  icon: null,
});

describe('live-model pure helpers', () => {
  it('floors timestamps onto 30m boundaries and builds ruler ticks', () => {
    expect(floorToEpgSlot(BASE + 17 * 60_000)).toBe(BASE);
    expect(floorToEpgSlot(BASE + 45 * 60_000)).toBe(BASE + EPG_SLOT_MS);
    expect(floorToEpgSlot(Number.NaN)).toBe(0);

    const ticks = buildEpgRulerTicks(BASE + 12 * 60_000, EPG_VISIBLE_SPAN_MS);
    expect(ticks).toHaveLength(6);
    expect(ticks[0]).toBe(BASE);
    expect(ticks[5]).toBe(BASE + 5 * EPG_SLOT_MS);
  });

  it('formats 24h clock times and handles invalid timestamps', () => {
    expect(formatClockTime(Number.NaN)).toBe('--:--');
    expect(formatClockTime(BASE)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('computes programme progress and vertical Now-line ratio accurately', () => {
    expect(computeProgramProgress(BASE, BASE + HOUR, BASE + 30 * 60_000)).toBeCloseTo(0.5);
    expect(computeProgramProgress(BASE, BASE + HOUR, BASE - 1_000)).toBe(0);
    expect(computeProgramProgress(BASE, BASE + HOUR, BASE + 2 * HOUR)).toBe(1);
    expect(computeProgramProgress(BASE, BASE, BASE)).toBe(0);

    expect(computeNowLineRatio(BASE, 2 * HOUR, BASE + HOUR)).toBeCloseTo(0.5);
    expect(computeNowLineRatio(BASE, 2 * HOUR, BASE - 1)).toBeNull();
    expect(computeNowLineRatio(BASE, 2 * HOUR, BASE + 3 * HOUR)).toBeNull();
  });

  it('clips and lays out EPG slots across window boundaries', () => {
    const progs = [
      makeProg(-60, -10, 'Past'),
      makeProg(-15, 45, 'Live Show'),
      makeProg(45, 120, 'Next Show'),
      makeProg(150, 240, 'Late Show'),
      makeProg(240, 300, 'After Window'),
    ];
    const slots = layoutEpgSlots(progs, BASE, EPG_VISIBLE_SPAN_MS, BASE + 15 * 60_000);
    expect(slots.map((s) => s.programme.title)).toEqual(['Live Show', 'Next Show', 'Late Show']);
    expect(slots[0]?.clippedStart).toBe(true);
    expect(slots[0]?.isLive).toBe(true);
    expect(slots[0]?.leftRatio).toBe(0);
    expect(slots[0]?.widthRatio).toBeCloseTo(45 / 180);
    expect(slots[2]?.clippedEnd).toBe(true);
    expect(slots[2]?.widthRatio).toBeCloseTo(30 / 180);
    expect(layoutEpgSlots([], BASE, EPG_VISIBLE_SPAN_MS, BASE)).toEqual([]);
  });

  it('preserves focus under the anchor time cursor across channels and gaps', () => {
    const progs = [makeProg(0, 60, 'A'), makeProg(90, 150, 'B')];
    expect(findProgramIndexAtTime([], BASE)).toBe(-1);
    expect(findProgramIndexAtTime(progs, BASE + 30 * 60_000)).toBe(0);
    expect(findProgramIndexAtTime(progs, BASE + 100 * 60_000)).toBe(1);
    // In gap [60, 90]: 65m is 5m after A and 25m before B -> nearest is A
    expect(findProgramIndexAtTime(progs, BASE + 65 * 60_000)).toBe(0);
    // 85m is 25m after A and 5m before B -> nearest is B
    expect(findProgramIndexAtTime(progs, BASE + 85 * 60_000)).toBe(1);
  });

  it('accumulates and parses 0-9 channel jump buffers safely', () => {
    let buf = '';
    buf = appendNumberDigit(buf, '0');
    buf = appendNumberDigit(buf, '1');
    buf = appendNumberDigit(buf, '2');
    buf = appendNumberDigit(buf, 'x');
    expect(buf).toBe('12');
    expect(parseNumberBuffer(buf)).toBe(12);
    expect(parseNumberBuffer('')).toBeNull();
    expect(parseNumberBuffer('123456')).toBeNull();
    expect(appendNumberDigit('12345', '9')).toBe('12345');
  });

  it('tracks active & previous channel history cleanly', () => {
    const s1 = recordChannelTune({ activeChannelKey: null, previousChannelKey: null }, 'ch:1');
    expect(s1).toEqual({ activeChannelKey: 'ch:1', previousChannelKey: null });
    const s2 = recordChannelTune(s1, 'ch:2');
    expect(s2).toEqual({ activeChannelKey: 'ch:2', previousChannelKey: 'ch:1' });
    const s3 = recordChannelTune(s2, 'ch:2');
    expect(s3).toEqual({ activeChannelKey: 'ch:2', previousChannelKey: 'ch:1' });
    const s4 = recordChannelTune(s3, 'ch:1');
    expect(s4).toEqual({ activeChannelKey: 'ch:1', previousChannelKey: 'ch:2' });
  });

  it('builds O(1) paged live PlayTarget and formats channel titles', async () => {
    const ch0: ItemRow = {
      id: 1,
      key: 'x:s1:live:1',
      kind: 'live',
      sourceId: 's1',
      providerId: '1',
      name: 'Studio News',
      logo: 'https://img.invalid/1.png',
      rating: null,
      year: null,
      num: 101,
    };
    const ch1: ItemRow = { ...ch0, id: 2, key: 'x:s1:live:2', name: 'Sports One', num: null };
    expect(formatLiveTitle(ch0)).toBe('101. Studio News');
    expect(formatLiveTitle(ch1)).toBe('Sports One');

    const loadPage = vi.fn(async () => [ch0, ch1]);
    const target = buildLiveHubPlayTarget({
      item: ch0,
      categoryId: 's1|live|news',
      categoryCount: 2,
      currentIndex: 0,
      loadPage,
    });
    expect(target.title).toBe('101. Studio News');
    const next = await target.playlist?.getAt(1);
    expect(next?.title).toBe('Sports One');
    expect(await target.playlist?.getAt(99)).toBeUndefined();
  });

  it('evicts oldest entries and expires TTL in BoundedTtlCache and indexes NowNext', () => {
    const cache = createBoundedTtlCache<string>(2, 1_000);
    cache.set('a', 'A', 100);
    cache.set('b', 'B', 200);
    expect(cache.get('a', 300)).toBe('A'); // refreshes LRU order
    cache.set('c', 'C', 400); // evicts 'b'
    expect(cache.get('b', 450)).toBeUndefined();
    expect(cache.get('a', 450)).toBe('A');
    expect(cache.get('a', 1_500)).toBeUndefined(); // expired (> 1000ms)
    expect(cache.size()).toBe(1);
    cache.clear();
    expect(cache.size()).toBe(0);

    const map = indexNowNext([
      { channelKey: 'x:s1:live:1', now: makeProg(0, 60, 'Now'), next: null },
    ]);
    expect(map.get('x:s1:live:1')?.now?.title).toBe('Now');
  });

  it('creates a synchronous static PagedListSource and defaults EMPTY_LIVE_MEMORY cleanly', async () => {
    expect(EMPTY_LIVE_MEMORY.mode).toBe('channels');
    const source = createStaticPagedListSource(['a', 'b']);
    expect(source.count()).toBe(2);
    expect(source.get(0)).toBe('a');
    expect(source.get(1)).toBe('b');
    expect(source.get(-1)).toBeUndefined();
    expect(source.get(2)).toBeUndefined();
    expect(await source.loadItem(1)).toBe('b');
    expect(await source.loadItem(9)).toBeUndefined();
    source.prefetch(0, 2);
    const unsub = source.onChange(() => undefined);
    unsub();
    source.dispose();
    expect(source.count()).toBe(0);
    expect(source.get(0)).toBeUndefined();
    expect(await source.loadItem(0)).toBeUndefined();
  });
});

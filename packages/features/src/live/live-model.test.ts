import type { ItemRow, ProgrammeRow } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import {
  appendNumberDigit,
  buildEpgRulerTicks,
  buildLiveHubPlayTarget,
  computeEpgClockPillLayout,
  computeNowLineRatio,
  computeProgramProgress,
  createBoundedTtlCache,
  createStaticPagedListSource,
  EMPTY_LIVE_MEMORY,
  EPG_SLOT_MS,
  EPG_VISIBLE_SPAN_MS,
  findOverlappingProgramIndex,
  findProgramIndexAtTime,
  floorToEpgSlot,
  formatClockTime,
  formatLiveTitle,
  indexNowNext,
  LIVE_ALPHABET_RAIL_MIN_ITEMS,
  layoutEpgSlots,
  MIN_EPG_GAP_MS,
  parseNumberBuffer,
  recordChannelTune,
  resolveEpgRowHeight,
  resolveLiveAlphabetLetter,
  stepLiveAlphabetLetter,
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
  genre: null,
  flags: 0,
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

  it('computes edge-clamped EPG ruler live clock pill anchor and colliding tick indices (#507)', () => {
    // Hidden when off-live or trackWidth <= 0
    expect(
      computeEpgClockPillLayout({
        trackWidth: 600,
        nowLineRatio: null,
        tickCount: 6,
        pillWidth: 52,
        tickLabelWidth: 44,
        gap: 6,
      }),
    ).toEqual({ visible: false, pillLeftPx: 0, hiddenTickIndices: new Set() });
    expect(
      computeEpgClockPillLayout({
        trackWidth: 0,
        nowLineRatio: 0.5,
        tickCount: 6,
        pillWidth: 52,
        tickLabelWidth: 44,
        gap: 6,
      }),
    ).toEqual({ visible: false, pillLeftPx: 0, hiddenTickIndices: new Set() });

    // Clamps to 0% left edge and hides tick 0
    const leftEdge = computeEpgClockPillLayout({
      trackWidth: 600,
      nowLineRatio: 0,
      tickCount: 6,
      pillWidth: 52,
      tickLabelWidth: 44,
      gap: 6,
    });
    expect(leftEdge.visible).toBe(true);
    expect(leftEdge.pillLeftPx).toBe(0);
    expect(Array.from(leftEdge.hiddenTickIndices)).toEqual([0]);

    // Centered at tick 1 (ratio 1/6 on 600px -> x=100, pill [74..126]) hides tick 1 ([100..144])
    const onTick1 = computeEpgClockPillLayout({
      trackWidth: 600,
      nowLineRatio: 1 / 6,
      tickCount: 6,
      pillWidth: 52,
      tickLabelWidth: 44,
      gap: 6,
    });
    expect(onTick1.pillLeftPx).toBeCloseTo(74, 4);
    expect(Array.from(onTick1.hiddenTickIndices)).toEqual([1]);

    // Clamps to 100% right edge without overflowing trackWidth (pill [548..600] + 6px gap collides with tick 5 [500..544])
    const rightEdge = computeEpgClockPillLayout({
      trackWidth: 600,
      nowLineRatio: 1,
      tickCount: 6,
      pillWidth: 52,
      tickLabelWidth: 44,
      gap: 6,
    });
    expect(rightEdge.pillLeftPx).toBe(548);
    expect(Array.from(rightEdge.hiddenTickIndices)).toEqual([5]);

    // Wider track (900px) at 100% right edge (pill [848..900] + 6px gap = 842) leaves tick 5 [750..794] visible
    const rightEdgeWide = computeEpgClockPillLayout({
      trackWidth: 900,
      nowLineRatio: 1,
      tickCount: 6,
      pillWidth: 52,
      tickLabelWidth: 44,
      gap: 6,
    });
    expect(rightEdgeWide.pillLeftPx).toBe(848);
    expect(rightEdgeWide.hiddenTickIndices.size).toBe(0);

    // 8px left padding offset accounts for actual tick text box [cellLeft + 8 .. cellLeft + 52]
    const withPadding = computeEpgClockPillLayout({
      trackWidth: 600,
      nowLineRatio: 80 / 600,
      tickCount: 6,
      pillWidth: 52,
      tickLabelWidth: 44,
      tickLabelOffset: 8,
      gap: 6,
    });
    // Pill is [54..106] with 6px gap -> [48..112]; tick 0 text [8..52] collides (52 > 48), tick 1 text [108..152] collides (108 < 112)
    expect(Array.from(withPadding.hiddenTickIndices)).toEqual([0, 1]);
  });

  it('clips and lays out EPG slots across window boundaries and synthesizes >= 5 min gap cells', () => {
    const progs = [
      makeProg(-60, -10, 'Past'),
      makeProg(-15, 45, 'Live Show'),
      makeProg(45, 120, 'Next Show'),
      makeProg(150, 240, 'Late Show'),
      makeProg(240, 300, 'After Window'),
    ];
    const slots = layoutEpgSlots(progs, BASE, EPG_VISIBLE_SPAN_MS, BASE + 15 * 60_000);
    // [0..45] Live Show, [45..120] Next Show, [120..150] 30m Gap, [150..180] Late Show
    expect(slots.map((s) => (s.isGap ? 'GAP' : s.programme?.title))).toEqual([
      'Live Show',
      'Next Show',
      'GAP',
      'Late Show',
    ]);
    expect(slots[0]?.clippedStart).toBe(true);
    expect(slots[0]?.isLive).toBe(true);
    expect(slots[0]?.leftRatio).toBe(0);
    expect(slots[0]?.widthRatio).toBeCloseTo(45 / 180);
    expect(slots[2]?.isGap).toBe(true);
    expect(slots[2]?.programme).toBeNull();
    expect(slots[2]?.id).toBe(`__gap:${BASE + 120 * 60_000}:${BASE + 150 * 60_000}`);
    expect(slots[2]?.leftRatio).toBeCloseTo(120 / 180);
    expect(slots[2]?.widthRatio).toBeCloseTo(30 / 180);
    expect(slots[3]?.clippedEnd).toBe(true);
    expect(slots[3]?.widthRatio).toBeCloseTo(30 / 180);

    // Empty row produces one full-window gap cell
    const emptySlots = layoutEpgSlots([], BASE, EPG_VISIBLE_SPAN_MS, BASE);
    expect(emptySlots).toHaveLength(1);
    expect(emptySlots[0]?.isGap).toBe(true);
    expect(emptySlots[0]?.id).toBe(`__gap:${BASE}:${BASE + EPG_VISIBLE_SPAN_MS}`);
    expect(emptySlots[0]?.leftRatio).toBe(0);
    expect(emptySlots[0]?.widthRatio).toBe(1);
  });

  it('ignores gaps shorter than MIN_EPG_GAP_MS (5 min) and synthesizes leading/trailing >= 5 min gaps', () => {
    expect(MIN_EPG_GAP_MS).toBe(300_000);
    const progs = [
      makeProg(10, 40, 'After Lead'), // 10m leading gap (>= 5m)
      makeProg(44, 90, 'Short Gap Next'), // 4m gap (< 5m -> ignored)
      makeProg(95, 160, 'Exact 5m Gap Next'), // 5m gap (>= 5m -> synthesized)
      // 20m trailing gap [160..180] (>= 5m -> synthesized)
    ];
    const slots = layoutEpgSlots(progs, BASE, EPG_VISIBLE_SPAN_MS, BASE + 15 * 60_000);
    expect(
      slots.map((s) => (s.isGap ? `GAP:${(s.stopMs - s.startMs) / 60_000}m` : s.programme?.title)),
    ).toEqual([
      'GAP:10m',
      'After Lead',
      'Short Gap Next',
      'GAP:5m',
      'Exact 5m Gap Next',
      'GAP:20m',
    ]);
  });

  it('resolves EPG row heights for compact, comfortable, and cinematic presets across TV and standard viewports', () => {
    expect(resolveEpgRowHeight('compact', true, 1)).toBe(52);
    expect(resolveEpgRowHeight('compact', false, 1)).toBe(48);
    expect(resolveEpgRowHeight('comfortable', true, 1)).toBe(68);
    expect(resolveEpgRowHeight('comfortable', false, 1)).toBe(60);
    expect(resolveEpgRowHeight('cinematic', true, 1)).toBe(84);
    expect(resolveEpgRowHeight('cinematic', false, 1)).toBe(74);
    expect(resolveEpgRowHeight(undefined, true, 1.2)).toBe(Math.round(68 * 1.2));
    expect(resolveEpgRowHeight('compact', false, 0.5)).toBe(48); // safeFontScale clamps >= 1
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

  it('selects the maximum time-overlap programme on vertical EPG moves with tie-breaks and gap fallback (#112)', () => {
    const MIN = 60_000;
    expect(findOverlappingProgramIndex([], BASE, BASE + 120 * MIN, BASE)).toBe(-1);

    // 2h movie [0, 120] vs 30m news [0, 30] + 90m drama [30, 120] -> selects 90m drama (index 1)
    const newsAndDrama = [makeProg(0, 30, 'News'), makeProg(30, 120, 'Drama')];
    expect(findOverlappingProgramIndex(newsAndDrama, BASE, BASE + 120 * MIN, BASE + 15 * MIN)).toBe(
      1,
    );

    // Midpoint trap: 2h movie [0, 120] (midpoint 60) vs 50m [0, 50], 20m brief [50, 70], 50m [70, 120]
    // Greatest overlap is 50m (indices 0 & 2), NOT the 20m midpoint slot; tie broken by |start - 0| -> index 0
    const midpointTrap = [
      makeProg(0, 50, 'First Feature'),
      makeProg(50, 70, 'Short Brief'),
      makeProg(70, 120, 'Second Feature'),
    ];
    expect(findOverlappingProgramIndex(midpointTrap, BASE, BASE + 120 * MIN, BASE + 60 * MIN)).toBe(
      0,
    );

    // Equal overlap tie-breaker prefers smaller |p.start - windowStartMs|
    const startTie = [makeProg(0, 80, 'Earlier Start'), makeProg(80, 140, 'Closer Start')];
    // Window [50, 110]: slot 0 overlap = 30m (|0-50|=50), slot 1 overlap = 30m (|80-50|=30) -> slot 1
    expect(
      findOverlappingProgramIndex(startTie, BASE + 50 * MIN, BASE + 110 * MIN, BASE + 55 * MIN),
    ).toBe(1);

    // Identical overlap and identical |start - windowStartMs| -> earlier index wins
    const exactTie = [makeProg(30, 90, 'First'), makeProg(90, 150, 'Second')];
    expect(
      findOverlappingProgramIndex(exactTie, BASE + 60 * MIN, BASE + 120 * MIN, BASE + 90 * MIN),
    ).toBe(0);

    // No positive overlap falls back to findProgramIndexAtTime(programmes, fallbackAnchorMs)
    const gapped = [makeProg(0, 45, 'Early'), makeProg(120, 180, 'Late')];
    expect(
      findOverlappingProgramIndex(gapped, BASE + 60 * MIN, BASE + 90 * MIN, BASE + 110 * MIN),
    ).toBe(1);
    expect(
      findOverlappingProgramIndex(gapped, BASE + 60 * MIN, BASE + 90 * MIN, BASE + 50 * MIN),
    ).toBe(0);

    // Degenerate window (stop <= start) falls back to fallbackAnchorMs
    expect(
      findOverlappingProgramIndex(newsAndDrama, BASE + 60 * MIN, BASE + 60 * MIN, BASE + 45 * MIN),
    ).toBe(1);
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

  it('resolves and steps Live A-Z alphabet buckets (#407)', () => {
    const buckets = [
      { letter: 'A', offset: 0, count: 15 },
      { letter: 'C', offset: 15, count: 20 },
      { letter: 'T', offset: 35, count: 10 },
    ] as const;
    expect(LIVE_ALPHABET_RAIL_MIN_ITEMS).toBe(40);
    expect(resolveLiveAlphabetLetter([], 0)).toBeNull();
    expect(resolveLiveAlphabetLetter(buckets, 0)).toBe('A');
    expect(resolveLiveAlphabetLetter(buckets, 14)).toBe('A');
    expect(resolveLiveAlphabetLetter(buckets, 15)).toBe('C');
    expect(resolveLiveAlphabetLetter(buckets, 40)).toBe('T');
    expect(stepLiveAlphabetLetter(buckets, 'A', 'down')).toBe('C');
    expect(stepLiveAlphabetLetter(buckets, 'C', 'down')).toBe('T');
    expect(stepLiveAlphabetLetter(buckets, 'T', 'up')).toBe('C');
  });
});

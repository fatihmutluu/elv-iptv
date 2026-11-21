import { describe, expect, it } from 'vitest';
import {
  count,
  emptyPanel,
  extinf,
  M3U_PASS,
  M3U_TOKEN,
  M3U_USER,
  setup,
  setupM3u,
} from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { isPlaceholderLiveChannel } from './placeholder-filter';
import { parseCategoryId, queryCategories, queryItems } from './queries';
import { querySearch } from './search';
import { getSource, updateSourceSettings } from './sources';

const cdn = (id: number) =>
  `http://cdn.example:8080/${M3U_TOKEN}/hb/s/${id}.ts?username=${M3U_USER}&password=${M3U_PASS}`;
const panelVod = (kind: string, id: number) =>
  `http://panel.example:8080/${kind}/${M3U_USER}/${M3U_PASS}/${id}.mkv`;

describe('isPlaceholderLiveChannel', () => {
  it('flags non-positive or non-finite numeric and sentinel string streamIds', () => {
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: 0 })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: -1 })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: -42 })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: Number.NaN })).toBe(true);
    expect(
      isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: Number.POSITIVE_INFINITY }),
    ).toBe(true);
    expect(
      isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: Number.NEGATIVE_INFINITY }),
    ).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '   ' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '0' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: ' 0 ' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '00' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '-1' })).toBe(true);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '-999' })).toBe(true);
  });

  it('accepts positive numeric/string streamIds and absent/null streamIds for valid names', () => {
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: 1 })).toBe(false);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: 100 })).toBe(false);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '100' })).toBe(false);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: '007' })).toBe(false);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel', streamId: null })).toBe(false);
    expect(isPlaceholderLiveChannel({ name: 'Valid Channel' })).toBe(false);
  });

  it('preserves nameless playable channels when streamId is valid or absent, and filters them with sentinel streamId', () => {
    for (const name of ['', '   ', '\t\n']) {
      expect(isPlaceholderLiveChannel({ name }), `expected "${name}" without id to pass`).toBe(
        false,
      );
      expect(
        isPlaceholderLiveChannel({ name, streamId: 101 }),
        `expected "${name}" with valid id to pass`,
      ).toBe(false);
      expect(
        isPlaceholderLiveChannel({ name, streamId: 0 }),
        `expected "${name}" with sentinel id 0 to be placeholder`,
      ).toBe(true);
      expect(
        isPlaceholderLiveChannel({ name, streamId: '0' }),
        `expected "${name}" with sentinel id "0" to be placeholder`,
      ).toBe(true);
    }
  });

  it('flags ASCII and Unicode decorative separator/symbol-only divider names', () => {
    for (const name of [
      '***',
      '---',
      '### === ###',
      '•••',
      '···',
      '=== | ===',
      '~:+/\\<>()[]{}.!',
      '___',
      '─── ═══ ───',
      '★★★',
      '✦✦✦',
      '▬▬▬',
    ]) {
      expect(isPlaceholderLiveChannel({ name }), `expected "${name}" to be placeholder`).toBe(true);
    }
  });

  it('flags exact static offline placeholder phrases with surrounding decoration and Turkish case variants', () => {
    for (const name of [
      'NO EVENT STREAMING',
      '--- NO EVENT STREAMING ---',
      '*** No Event Streaming! ***',
      '[no-event-streaming]',
      'NO EVENT STREAMING - 20:00',
      '--- NO EVENT STREAMING (CH 12) ---',
      'No Event',
      '=== NO EVENT ===',
      'No Live Event',
      '### NO LIVE EVENT ###',
      'No Events',
      '--- NO EVENTS ---',
      'Event Not Started',
      '** Event Not Started **',
      'No Stream Available',
      '-- No Stream Available --',
      'Offline Placeholder',
      'Offline Placeholder!',
      'Channel Offline',
      '--- Channel Offline ---',
      'NO EVENT STREAMİNG',
      'no event streamıng',
      'NO LİVE EVENT',
      'OFFLİNE PLACEHOLDER',
      'CHANNEL OFFLİNE',
    ]) {
      expect(isPlaceholderLiveChannel({ name }), `expected "${name}" to be placeholder`).toBe(true);
    }
  });

  it('is strictly conservative and preserves legitimate channel names', () => {
    for (const name of [
      'Event Cinema',
      'Live Sports 1',
      'No Country 24',
      'Channel 101',
      'Offline Drama',
      'No Event Horizon',
      'No Event 24',
      'Channel Offline Docs',
      '*** Sports HD ***',
      '--- Sports 1 ---',
      '#1 News',
      'Live News',
      'No Limits TV',
      'TR: Haber Bir HD',
      'Prime Sports 1',
      'No Event StreamingTV',
    ]) {
      expect(isPlaceholderLiveChannel({ name, streamId: 101 }), `expected "${name}" to pass`).toBe(
        false,
      );
    }
  });
});

describe('placeholder filtering during Xtream import', () => {
  function panelWithPlaceholders() {
    const d = emptyPanel();
    d.liveCats = [
      { category_id: '1', category_name: 'Sports Events' },
      { category_id: '2', category_name: 'Only Placeholders' },
    ];
    d.vodCats = [{ category_id: '10', category_name: 'Movies' }];
    d.live = [
      { num: 1, name: 'Live Sports 1', stream_id: 100, category_id: '1' },
      { num: 2, name: '--- NO EVENT STREAMING ---', stream_id: 101, category_id: '1' },
      { num: 3, name: '***', stream_id: 102, category_id: '1' },
      { num: 4, name: 'Event Cinema', stream_id: 103, category_id: '1' },
      { num: 5, name: 'Sentinel Slot', stream_id: 0, category_id: '2' },
    ];
    d.vod = [{ name: 'No Event', stream_id: 200, category_id: '10' }];
    return d;
  }

  it('skips placeholder live channels by default, excludes them from queries & FTS5, and records skippedPlaceholders', async () => {
    const e = await setup(panelWithPlaceholders());
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.counts.live).toBe(2);
    expect(r.value.counts.movies).toBe(1);
    expect(r.value.counts.skippedPlaceholders).toBe(3);
    expect(await count(e.db, 'live')).toBe(2);

    const cats = await queryCategories(e.db, e.sourceId, 'live');
    expect(cats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
      { name: 'Sports Events', itemCount: 2 },
      { name: 'Only Placeholders', itemCount: 0 },
    ]);

    const sportsCat = cats[0];
    const sportsRef = sportsCat === undefined ? undefined : parseCategoryId(sportsCat.id);
    if (sportsRef === undefined) throw new Error('expected sports category');
    const items = await queryItems(e.db, sportsRef, 0, 50);
    expect(items.map((i) => i.name)).toEqual(['Live Sports 1', 'Event Cinema']);

    const searchNoEvent = await querySearch(e.db, 'no event', { scope: 'live' });
    expect(searchNoEvent.live).toEqual([]);
    const searchSentinel = await querySearch(e.db, 'sentinel', { scope: 'live' });
    expect(searchSentinel.live).toEqual([]);
    const searchMovie = await querySearch(e.db, 'no event', { scope: 'movie' });
    expect(searchMovie.movies.map((m) => m.name)).toEqual(['No Event']);
    const searchReal = await querySearch(e.db, 'event cinema', { scope: 'live' });
    expect(searchReal.live.map((l) => l.name)).toEqual(['Event Cinema']);
  });

  it('preserves placeholder live channels when includePlaceholderChannels is true', async () => {
    const e = await setup(panelWithPlaceholders());
    const source = await getSource(e.db, e.sourceId);
    if (source === undefined) throw new Error('expected source');
    await updateSourceSettings(e.db, e.sourceId, {
      ...source.settings,
      includePlaceholderChannels: true,
    });

    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.counts.live).toBe(5);
    expect('skippedPlaceholders' in r.value.counts).toBe(false);
    expect(await count(e.db, 'live')).toBe(5);

    const cats = await queryCategories(e.db, e.sourceId, 'live');
    expect(cats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
      { name: 'Sports Events', itemCount: 4 },
      { name: 'Only Placeholders', itemCount: 1 },
    ]);

    const searchNoEvent = await querySearch(e.db, 'no event', { scope: 'live' });
    expect(searchNoEvent.live.map((l) => l.name)).toEqual(['--- NO EVENT STREAMING ---']);
  });

  it('omits skippedPlaceholders when no placeholders are encountered', async () => {
    const d = emptyPanel();
    d.liveCats = [{ category_id: '1', category_name: 'News' }];
    d.live = [{ num: 1, name: 'Haber Bir', stream_id: 100, category_id: '1' }];
    const e = await setup(d);
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.live).toBe(1);
    expect('skippedPlaceholders' in r.value.counts).toBe(false);
  });

  it('fails with empty-source when every Xtream item is a placeholder', async () => {
    const d = emptyPanel();
    d.liveCats = [{ category_id: '1', category_name: 'Events' }];
    d.live = [
      { num: 1, name: '--- NO EVENT STREAMING ---', stream_id: 101, category_id: '1' },
      { num: 2, name: '***', stream_id: 102, category_id: '1' },
    ];
    const e = await setup(d);
    const r = await importCatalog(e.sourceId, e.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('source-format');
      expect(r.error.code).toBe('empty-source');
    }
  });

  it('filters placeholders during per-category fallback as well', async () => {
    const e = await setup(panelWithPlaceholders());
    e.panel.state.bloat.add('get_live_streams');
    e.deps.maxBodyBytes = 800;
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.live).toBe(2);
    expect(r.value.counts.skippedPlaceholders).toBe(3);
  });
});

describe('placeholder filtering during M3U import', () => {
  function m3uWithPlaceholders(): string {
    return (
      '#EXTM3U\n' +
      extinf('Live Sports 1', cdn(101), 'group-title="Sports Events"') +
      extinf('--- NO EVENT STREAMING ---', cdn(102), 'group-title="Sports Events"') +
      extinf('***', cdn(103), 'group-title="Sports Events"') +
      extinf('Channel Offline', cdn(104), 'group-title="Dead Group"') +
      extinf('Event Cinema', cdn(105), 'group-title="Sports Events"') +
      extinf('No Event', panelVod('movie', 201), 'group-title="Movies"') +
      extinf('No Event S01E01', panelVod('series', 301), 'group-title="Drama"')
    );
  }

  it('skips M3U live placeholders, keeps VOD movies & series untouched, and excludes placeholders from queries & FTS5', async () => {
    const e = await setupM3u(m3uWithPlaceholders());
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.counts.live).toBe(2);
    expect(r.value.counts.movies).toBe(1);
    expect(r.value.counts.series).toBe(1);
    expect(r.value.counts.episodes).toBe(1);
    expect(r.value.counts.skippedPlaceholders).toBe(3);
    expect(await count(e.db, 'live')).toBe(2);

    const cats = await queryCategories(e.db, e.sourceId, 'live');
    expect(cats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
      { name: 'Sports Events', itemCount: 2 },
    ]);

    const sportsCat = cats[0];
    const sportsRef = sportsCat === undefined ? undefined : parseCategoryId(sportsCat.id);
    if (sportsRef === undefined) throw new Error('expected sports category');
    const items = await queryItems(e.db, sportsRef, 0, 50);
    expect(items.map((i) => i.name)).toEqual(['Live Sports 1', 'Event Cinema']);

    const searchLive = await querySearch(e.db, 'no event', { scope: 'live' });
    expect(searchLive.live).toEqual([]);
    const searchOffline = await querySearch(e.db, 'channel offline', { scope: 'live' });
    expect(searchOffline.live).toEqual([]);
    const searchMovie = await querySearch(e.db, 'no event', { scope: 'movie' });
    expect(searchMovie.movies.map((m) => m.name)).toEqual(['No Event']);
  });

  it('preserves M3U live placeholders when includePlaceholderChannels is true', async () => {
    const e = await setupM3u(m3uWithPlaceholders());
    const source = await getSource(e.db, e.sourceId);
    if (source === undefined) throw new Error('expected source');
    await updateSourceSettings(e.db, e.sourceId, {
      ...source.settings,
      includePlaceholderChannels: true,
    });

    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));

    expect(r.value.counts.live).toBe(5);
    expect('skippedPlaceholders' in r.value.counts).toBe(false);

    const cats = await queryCategories(e.db, e.sourceId, 'live');
    expect(cats.map((c) => ({ name: c.name, itemCount: c.itemCount }))).toEqual([
      { name: 'Sports Events', itemCount: 4 },
      { name: 'Dead Group', itemCount: 1 },
    ]);

    const searchLive = await querySearch(e.db, 'no event', { scope: 'live' });
    expect(searchLive.live.map((l) => l.name)).toEqual(['--- NO EVENT STREAMING ---']);
  });

  it('does not filter entries in a vodPlaylist', async () => {
    const body =
      '#EXTM3U\n' +
      extinf('--- NO EVENT STREAMING ---', cdn(101), 'group-title="VOD"') +
      extinf('***', cdn(102), 'group-title="VOD"');
    const e = await setupM3u(body, { vodPlaylist: true });
    const r = await importCatalog(e.sourceId, e.deps);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.counts.movies).toBe(2);
    expect('skippedPlaceholders' in r.value.counts).toBe(false);
  });

  it('fails with empty-source when every M3U entry is a live placeholder', async () => {
    const body =
      '#EXTM3U\n' +
      extinf('--- NO EVENT STREAMING ---', cdn(101), 'group-title="Events"') +
      extinf('***', cdn(102), 'group-title="Events"');
    const e = await setupM3u(body);
    const r = await importCatalog(e.sourceId, e.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('source-format');
      expect(r.error.code).toBe('empty-source');
    }
  });
});

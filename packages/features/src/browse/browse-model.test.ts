import type { CategoryRow, EpisodeRow, ItemRow, SourceRow } from '@elv/data';
import { elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  buildDisplayCategories,
  describeCatalogReadFailure,
  EMPTY_TAB_MEMORY,
  formatEpisodeLabel,
  formatItemTitle,
  resolveSelectedCategoryIndex,
} from './browse-model';

const SRC_A: SourceRow = {
  id: 'src-a',
  kind: 'xtream',
  name: 'Alpha Server',
  createdAt: 1,
  needsImport: false,
};

const SRC_B: SourceRow = {
  id: 'src-b',
  kind: 'm3u',
  name: 'Beta List',
  createdAt: 2,
  needsImport: false,
};

const CAT_A1: CategoryRow = {
  id: 'src-a|live|1',
  sourceId: 'src-a',
  kind: 'live',
  name: 'News',
  position: 0,
  itemCount: 12,
};

const CAT_B1: CategoryRow = {
  id: 'src-b|live|10',
  sourceId: 'src-b',
  kind: 'live',
  name: 'Sports',
  position: 0,
  itemCount: 0,
};

describe('browse-model', () => {
  it('keeps plain category labels for a single source and prefixes source name for multiple sources', () => {
    const map = new Map<string, readonly CategoryRow[]>([
      ['src-a', [CAT_A1]],
      ['src-b', [CAT_B1]],
    ]);

    expect(buildDisplayCategories([SRC_A], map)).toEqual([{ row: CAT_A1, label: 'News' }]);

    expect(buildDisplayCategories([SRC_A, SRC_B], map)).toEqual([
      { row: CAT_A1, label: 'Alpha Server — News' },
      { row: CAT_B1, label: 'Beta List — Sports' },
    ]);
  });

  it('resolves selected category index by categoryId first, then clamped fallback index', () => {
    const list = buildDisplayCategories(
      [SRC_A, SRC_B],
      new Map([
        ['src-a', [CAT_A1]],
        ['src-b', [CAT_B1]],
      ]),
    );
    expect(resolveSelectedCategoryIndex(list, EMPTY_TAB_MEMORY)).toBe(0);
    expect(
      resolveSelectedCategoryIndex(list, {
        categoryId: 'src-b|live|10',
        categoryIndex: 0,
        itemIndex: 0,
      }),
    ).toBe(1);
    expect(
      resolveSelectedCategoryIndex(list, {
        categoryId: 'missing',
        categoryIndex: 99,
        itemIndex: 0,
      }),
    ).toBe(1);
    expect(resolveSelectedCategoryIndex([], EMPTY_TAB_MEMORY)).toBe(0);
  });

  it('formats live channel numbers and movie/series release years cleanly', () => {
    const base: ItemRow = {
      id: 1,
      key: 'x:src-a:live:101',
      kind: 'live',
      sourceId: 'src-a',
      providerId: '101',
      name: 'Channel One',
      logo: null,
      rating: null,
      year: null,
      num: 101,
    };
    expect(formatItemTitle(base)).toBe('101. Channel One');
    expect(formatItemTitle({ ...base, num: null })).toBe('Channel One');

    expect(
      formatItemTitle({
        ...base,
        kind: 'movie',
        name: 'Feature One',
        num: null,
        year: 2024,
      }),
    ).toBe('Feature One (2024)');
    expect(
      formatItemTitle({
        ...base,
        kind: 'series',
        name: 'Series One',
        num: null,
        year: null,
      }),
    ).toBe('Series One');
  });

  it('formats titled and untitled episodes in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const titled: EpisodeRow = {
      id: 10,
      key: 'x:src-a:ep:10',
      season: 1,
      episode: 2,
      title: 'Arrival',
      durationSec: 2400,
    };
    const untitled: EpisodeRow = {
      id: 11,
      key: 'x:src-a:ep:11',
      season: 1,
      episode: null,
      title: '   ',
      durationSec: null,
    };

    expect(formatEpisodeLabel(titled, 0, 'Show A', en.t)).toEqual({
      rowText: 'E2 · Arrival',
      playTitle: 'Show A — E2 · Arrival',
    });
    expect(formatEpisodeLabel(untitled, 4, 'Show A', tr.t)).toEqual({
      rowText: '5. Bölüm',
      playTitle: 'Show A — 5. Bölüm',
    });
  });

  it('describes catalog read failures across auth, network, and storage categories', () => {
    expect(describeCatalogReadFailure(elvError('auth', 'invalid-credentials')).messageId).toBe(
      'source.error.invalidCredentials',
    );
    expect(describeCatalogReadFailure(elvError('auth', 'account-expired')).messageId).toBe(
      'source.error.accountExpired',
    );
    expect(describeCatalogReadFailure(elvError('network', 'rate-limited')).messageId).toBe(
      'source.error.rateLimited',
    );
    expect(describeCatalogReadFailure(elvError('network', 'timeout')).messageId).toBe(
      'source.error.timeout',
    );
    expect(describeCatalogReadFailure(elvError('network', 'unreachable')).messageId).toBe(
      'source.error.unreachable',
    );
    expect(describeCatalogReadFailure(elvError('storage', 'item-not-found')).messageId).toBe(
      'player.error.itemNotFound',
    );
    expect(describeCatalogReadFailure(elvError('storage', 'disk-full')).messageId).toBe(
      'source.error.storage',
    );
  });
});

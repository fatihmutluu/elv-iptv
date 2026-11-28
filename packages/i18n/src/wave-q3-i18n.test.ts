import { describe, expect, it } from 'vitest';
import { createAppI18n, type MessageId } from './index';

describe('Wave Q3 i18n catalogs', () => {
  it('localizes Series Detail Scope Picker & series download/watched actions in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['detail.scopePicker.watchedAction', 'Watched options', 'İzlendi seçenekleri'],
      ['detail.scopePicker.watchedTitle', 'Mark watched', 'İzlendi işaretle'],
      ['detail.scopePicker.downloadAction', 'Download options', 'İndirme seçenekleri'],
      ['detail.scopePicker.downloadTitle', 'Download episodes', 'Bölümleri indir'],
      ['detail.scopePicker.entireSeries', 'Entire series', 'Tüm dizi'],
      ['detail.scopePicker.season', 'Season', 'Sezon'],
      ['detail.scopePicker.chooseSeason', 'Choose season', 'Sezon seç'],
      [
        'detail.scopePicker.markEntireSeriesWatched',
        'Mark entire series watched',
        'Tüm diziyi izlendi işaretle',
      ],
      [
        'detail.scopePicker.markEntireSeriesUnwatched',
        'Mark entire series unwatched',
        'Tüm diziyi izlenmedi işaretle',
      ],
      ['detail.scopePicker.downloadEntireSeries', 'Download entire series', 'Tüm diziyi indir'],
    ];

    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('detail.scopePicker.downloadActionActive', { count: 3 })).toBe('Downloading (3)');
    expect(tr.t('detail.scopePicker.downloadActionActive', { count: 3 })).toBe('İndiriliyor (3)');
    expect(en.t('detail.scopePicker.downloadActionCompleted', { count: 5 })).toBe('5 downloaded');
    expect(tr.t('detail.scopePicker.downloadActionCompleted', { count: 5 })).toBe('5 indirildi');
    expect(en.t('detail.scopePicker.markSeasonWatched', { season: 2 })).toBe(
      'Mark Season 2 watched',
    );
    expect(tr.t('detail.scopePicker.markSeasonWatched', { season: 2 })).toBe(
      '2. Sezonu izlendi işaretle',
    );
    expect(en.t('detail.scopePicker.markSeasonUnwatched', { season: 2 })).toBe(
      'Mark Season 2 unwatched',
    );
    expect(tr.t('detail.scopePicker.markSeasonUnwatched', { season: 2 })).toBe(
      '2. Sezonu izlenmedi işaretle',
    );
    expect(en.t('detail.scopePicker.downloadSeason', { season: 3 })).toBe('Download Season 3');
    expect(tr.t('detail.scopePicker.downloadSeason', { season: 3 })).toBe('3. Sezonu indir');
    expect(en.t('detail.scopePicker.seasonEpisodesCount', { count: 12 })).toBe('12 episodes');
    expect(tr.t('detail.scopePicker.seasonEpisodesCount', { count: 12 })).toBe('12 bölüm');
  });
});

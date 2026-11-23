import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { DetailScreen } from '../DetailScreen';

const EN_I18N = createAppI18n('en');

function wrap(node: ReactElement) {
  return (
    <ThemeProvider>
      <I18nProvider i18n={EN_I18N}>
        <ViewportProvider value={{ width: 1280, height: 720, formFactor: 'desktop' }}>
          {node}
        </ViewportProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function makeStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    addSource: jest.fn(async () =>
      ok({ id: 's1', kind: 'xtream' as const, name: 'X', createdAt: 1, needsImport: true }),
    ),
    addSourceFromLink: jest.fn(async () =>
      ok({ id: 's1', kind: 'm3u' as const, name: 'M', createdAt: 1, needsImport: true }),
    ),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource: jest.fn(async () =>
      ok({
        runId: 1,
        counts: { live: 0, movies: 2, series: 0 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/1.mp4', headers: {} })),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe('DetailScreen multi-version VOD selector (#404)', () => {
  it('shows multi-version VOD selector in DetailScreen and plays selected version', async () => {
    const onPlay = jest.fn();
    const catalog = makeStubCatalog({
      itemDetail: jest.fn(async () => ({
        id: 1,
        key: 'x:s1:movie:1',
        sourceId: 's1',
        providerId: '1',
        kind: 'movie' as const,
        name: 'Dune',
        year: 2021,
        rating: 8.2,
        num: null,
        logo: null,
        plot: 'Desert planet.',
      })),
      getProgress: jest.fn(async () => ({
        profileId: 'default',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie' as const,
        title: 'Dune',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 60_000,
        durationMs: 7_200_000,
        watched: false,
        updatedAt: 1,
        preferredItemKey: 'x:s1:movie:2',
      })),
      itemVersions: jest.fn(async () => [
        {
          key: 'x:s1:movie:1',
          title: 'Dune [4K]',
          versionLabel: '4K',
          year: 2021,
          qualityRank: 40,
        },
        {
          key: 'x:s1:movie:2',
          title: 'Dune [1080p]',
          versionLabel: '1080p',
          year: 2021,
          qualityRank: 30,
        },
      ]),
    });

    const screen = await render(
      wrap(
        <DetailScreen
          target={{
            itemKey: 'x:s1:movie:1',
            sourceId: 's1',
            kind: 'movie',
            title: 'Dune',
            posterUri: null,
            backdropUri: null,
            year: 2021,
            rating: 8.2,
          }}
          catalog={catalog}
          refreshToken={0}
          onBack={jest.fn()}
          onPlay={onPlay}
          onOpenDetail={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByTestId('detail-preplay-version')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    await fireEvent.press(screen.getByTestId('detail-play'));

    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:movie:1',
        title: 'Dune [4K]',
      }),
    );
  });
});

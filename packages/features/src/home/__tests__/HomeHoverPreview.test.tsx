import type { CatalogService } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { PosterHoverPreviewProvider } from '../../shared/PosterHoverPreviewContext';
import { PosterHoverPreviewHost } from '../../shared/PosterHoverPreviewHost';
import { HOVER_PREVIEW_OPEN_DELAY_MS } from '../../shared/poster-hover-preview-model';
import { buildHomeRailSpecs, HomeSectionsList } from '../HomeRail';
import type { HomeRailEntry } from '../home-model';

describe('HomeSectionsList Hover Preview (Wave R3)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('passes entry.overview synchronously to PosterHoverPreviewCard and omits dismiss action on My List & Collections', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const pendingCatalog = {
      itemDetail: jest.fn(() => new Promise(() => undefined)),
      getElvEnrichmentForKeys: jest.fn(() => new Promise(() => undefined)),
    } as unknown as CatalogService;
    const i18n = createAppI18n('en');
    const baseEntry: HomeRailEntry = {
      itemKey: 'x:s1:movie:500',
      sourceId: 's1',
      kind: 'movie',
      title: 'Starfall Signal',
      subtitle: null,
      backdropUri: null,
      posterUri: null,
      overview: 'Immediate overview passed straight from HomeRail.',
      year: 2025,
      rating: 8.3,
      durationMs: 0,
      positionMs: 0,
      watched: false,
    };
    const specs = buildHomeRailSpecs(i18n.t);
    const specsById = new Map(specs.map((s) => [s.id, s]));

    const view = await render(
      <I18nProvider i18n={i18n}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', inputModality: 'pointer' }}
          >
            <PosterHoverPreviewProvider catalog={pendingCatalog} catalogRevision={1}>
              <HomeSectionsList
                visibleSections={[
                  { id: 'movies', visible: true },
                  { id: 'mylist', visible: true },
                  { id: 'collections', visible: true },
                ]}
                railSpecsById={specsById}
                railSets={{
                  continue: [],
                  elvShowcase: [],
                  newEpisodes: [],
                  live: [],
                  movies: [baseEntry],
                  series: [],
                  mylist: [{ ...baseEntry, itemKey: 'x:s1:movie:502', title: 'Saved List Film' }],
                }}
                collectionRails={[
                  {
                    id: 'collection:c1',
                    collectionId: 'c1',
                    title: 'Curated Picks',
                    items: [{ ...baseEntry, itemKey: 'x:s1:movie:501', title: 'Collection Film' }],
                  },
                ]}
                wideCardWidth={240}
                posterCardWidth={168}
                gap={14}
                padX={24}
                isTv={false}
                isTouch={false}
                focusedRowId={null}
                focusedCol={null}
                favoriteKeys={new Set(['x:s1:movie:502'])}
                watchedOverrides={new Map()}
                unplayedBySeriesKey={new Map()}
                onOpenTab={jest.fn()}
                onPressWideItem={jest.fn()}
                onPressPosterItem={jest.fn()}
                onContextMenuItem={jest.fn()}
                onQuickPlay={jest.fn()}
                onQuickToggleFavorite={jest.fn()}
                onQuickToggleWatched={jest.fn()}
                onDismissRecommendation={jest.fn()}
                onLayoutY={jest.fn()}
              />
              <PosterHoverPreviewHost onPlay={jest.fn()} onOpenDetail={jest.fn()} />
            </PosterHoverPreviewProvider>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });

    // Discovery rail (Movies) displays synchronous overview and dismiss action
    await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('hover-preview-synopsis')).toHaveTextContent(
      'Immediate overview passed straight from HomeRail.',
    );
    expect(screen.getByTestId('hover-preview-dismiss')).toBeTruthy();

    // My List rail omits Don't recommend again button
    await fireEvent(screen.getByTestId('home-movies-item-0'), 'pointerLeave');
    await fireEvent(screen.getByTestId('home-mylist-item-0'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('hover-preview-title')).toHaveTextContent('Saved List Film');
    expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();

    // Collections rail omits Don't recommend again button
    await fireEvent(screen.getByTestId('home-mylist-item-0'), 'pointerLeave');
    await fireEvent(screen.getByTestId('home-collection-c1-item-0'), 'pointerEnter');
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('hover-preview-title')).toHaveTextContent('Collection Film');
    expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();

    jest.useRealTimers();
    await view.unmount();
  });
});

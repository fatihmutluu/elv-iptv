import type { CatalogService, ElvItemEnrichment, ItemDetailRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, PosterCard, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, View } from 'react-native';
import type { VideoHost } from '../../ports/video-host';
import { PosterHoverPreviewProvider, usePosterHoverPreview } from '../PosterHoverPreviewContext';
import { PosterHoverPreviewHost } from '../PosterHoverPreviewHost';
import {
  HOVER_PREVIEW_CLOSE_DELAY_MS,
  HOVER_PREVIEW_OPEN_DELAY_MS,
} from '../poster-hover-preview-model';

function TestCardTrigger({
  itemKey = 'x:s1:movie:1',
  overview,
  allowDismissRecommendation,
  onPlay,
  onOpenDetail,
  onDismissRecommendation,
}: {
  readonly itemKey?: string;
  readonly overview?: string | null;
  readonly allowDismissRecommendation?: boolean;
  readonly onPlay?: () => void;
  readonly onOpenDetail?: () => void;
  readonly onDismissRecommendation?: () => void;
}) {
  const hover = usePosterHoverPreview();
  return (
    <PosterCard
      testID={`trigger-${itemKey}`}
      title="Nebula Drift"
      width={170}
      onPress={onOpenDetail}
      onHoverPreviewStart={(rect) =>
        hover.scheduleOpen(
          {
            itemKey,
            sourceId: 's1',
            kind: 'movie',
            title: 'Nebula Drift',
            posterUri: 'https://art.example/nebula.jpg',
            year: 2024,
            rating: 8.4,
            ...(overview !== undefined ? { overview } : {}),
            ...(allowDismissRecommendation !== undefined ? { allowDismissRecommendation } : {}),
            onPlay,
            onOpenDetail,
            onDismissRecommendation,
          },
          rect,
          170,
        )
      }
      onHoverPreviewEnd={() => hover.scheduleClose(itemKey)}
    />
  );
}

function makeTestCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  const detail: ItemDetailRow = {
    id: 1,
    key: 'x:s1:movie:1',
    sourceId: 's1',
    providerId: '1',
    kind: 'movie',
    name: 'Nebula Drift',
    logo: 'https://art.example/nebula.jpg',
    num: null,
    year: 2024,
    rating: 8.4,
    plot: 'A navigator charts an uncharted singularity.',
  };
  const enrichment: ElvItemEnrichment = {
    itemKey: 'x:s1:movie:1',
    sourceId: 's1',
    mediaType: 'movie',
    imdbId: 'tt9991112',
    confidence: 0.99,
    manualLock: false,
    title: {
      imdbId: 'tt9991112',
      mediaType: 'movie',
      originalTitle: 'Nebula Drift',
      englishTitle: 'Nebula Drift',
      localizedTitles: {},
      year: 2024,
      rating: 8.6,
      votes: 50_000,
      runtimeMin: 134,
      genres: ['Sci-Fi'],
      posterUrl: 'https://art.example/nebula.jpg',
      backdropUrl: 'https://art.example/nebula-bg.jpg',
      trailerStreamUrl: 'https://cdn.example/nebula-trailer.mp4',
      trailerYoutubeId: null,
      director: null,
      cast: [],
      mltImdbIds: [],
      franchiseKey: null,
      franchiseName: null,
      franchiseOrder: null,
      synopses: { en: 'Enriched space synopsis.' },
      detailFetchedAt: 100,
      updatedAt: 100,
    },
  };
  return {
    itemDetail: jest.fn(async () => detail),
    getElvEnrichmentForKeys: jest.fn(async () => new Map([[detail.key, enrichment]])),
    ...overrides,
  } as unknown as CatalogService;
}

describe('PosterHoverPreviewHost & PosterHoverPreviewContext (Wave R3)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('opens after 350ms dwell, cancels if left early, keeps open when entering preview card, and dismisses on scroll/Escape', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const catalog = makeTestCatalog();
    const onPlay = jest.fn();
    const onOpenDetail = jest.fn();
    const onDismissRecommendation = jest.fn();
    const i18n = createAppI18n('en');

    const winListeners = new Map<string, Set<(e?: unknown) => void>>();
    const origWindow = (globalThis as { window?: unknown }).window;
    const mockWin = {
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener: jest.fn((type: string, fn: (e?: unknown) => void) => {
        let set = winListeners.get(type);
        if (!set) {
          set = new Set();
          winListeners.set(type, set);
        }
        set.add(fn);
      }),
      removeEventListener: jest.fn((type: string, fn: (e?: unknown) => void) => {
        winListeners.get(type)?.delete(fn);
      }),
    };
    Object.defineProperty(globalThis, 'window', { value: mockWin, configurable: true });

    try {
      const view = await render(
        <I18nProvider i18n={i18n}>
          <ThemeProvider>
            <ViewportProvider
              value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
            >
              <PosterHoverPreviewProvider catalog={catalog} catalogRevision={1} elvEnrichActive>
                <TestCardTrigger
                  onPlay={onPlay}
                  onOpenDetail={onOpenDetail}
                  onDismissRecommendation={onDismissRecommendation}
                />
                <PosterHoverPreviewHost onPlay={onPlay} onOpenDetail={onOpenDetail} />
              </PosterHoverPreviewProvider>
            </ViewportProvider>
          </ThemeProvider>
        </I18nProvider>,
      );

      const card = screen.getByTestId('trigger-x:s1:movie:1');
      const cardContainer = screen.getByTestId('trigger-x:s1:movie:1-hover-container');

      // Leave before 350ms dwell -> never opens
      await fireEvent(card, 'hoverIn', {
        currentTarget: {
          getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
        },
      });
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS - 50);
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
      await fireEvent(cardContainer, 'pointerLeave');
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();

      // Dwell full 350ms -> opens + hydrates synopsis/runtime/trailer
      await fireEvent(cardContainer, 'pointerEnter', {
        currentTarget: {
          getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
        },
      });
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      expect(screen.getByTestId('hover-preview-synopsis')).toHaveTextContent(
        'Enriched space synopsis.',
      );
      expect(screen.getByTestId('hover-preview-meta')).toHaveTextContent('2024 · ★ 8.6 · 134 min');

      // Moving pointer off trigger onto preview card cancels the 160ms close timer
      await fireEvent(cardContainer, 'pointerLeave');
      await fireEvent(screen.getByTestId('poster-hover-preview-card'), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_CLOSE_DELAY_MS + 100);
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();

      // Window Escape immediately closes preview
      await act(async () => {
        for (const fn of winListeners.get('keydown') ?? []) {
          fn({ key: 'Escape', preventDefault: jest.fn() });
        }
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();

      // Re-hover uses cached metadata (zero redundant itemDetail/getElvEnrichmentForKeys calls)
      await fireEvent(cardContainer, 'pointerLeave');
      await fireEvent(cardContainer, 'pointerEnter', {
        currentTarget: {
          getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
        },
      });
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });
      expect(screen.getByTestId('poster-hover-preview-card')).toBeTruthy();
      expect(catalog.itemDetail).toHaveBeenCalledTimes(1);
      expect(catalog.getElvEnrichmentForKeys).toHaveBeenCalledTimes(1);

      // Window scroll immediately closes preview
      await act(async () => {
        for (const fn of winListeners.get('scroll') ?? []) fn();
      });
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();

      // Clicking "Don't recommend again" invokes dismiss callback and closes preview immediately
      await fireEvent(cardContainer, 'pointerLeave');
      await fireEvent(cardContainer, 'pointerEnter', {
        currentTarget: {
          getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
        },
      });
      await act(async () => {
        jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
        await Promise.resolve();
      });
      await fireEvent.press(screen.getByTestId('hover-preview-dismiss'));
      expect(onDismissRecommendation).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();

      await view.unmount();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: origWindow, configurable: true });
    }
  });

  it('opens DetailTrailerModal when clicking Trailer inside the hover preview and never activates on TV/Touch', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const catalog = makeTestCatalog();
    const videoHost: VideoHost = {
      open: () => ({
        engine: {
          open: jest.fn(),
          play: jest.fn(),
          pause: jest.fn(),
          seek: jest.fn(),
          stop: jest.fn(),
          setMuted: jest.fn(),
          setVolume: jest.fn(),
          setRate: jest.fn(),
          onEvent: () => () => undefined,
        } as never,
        renderSurface: ({ testID }) => <View testID={testID ?? 'trailer-surface'} />,
      }),
    };

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
          >
            <PosterHoverPreviewProvider catalog={catalog} catalogRevision={1} elvEnrichActive>
              <TestCardTrigger />
              <PosterHoverPreviewHost
                videoHost={videoHost}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
                renderTrailerModal={(modalProps) =>
                  modalProps.visible ? (
                    <View
                      testID="detail-trailer-modal"
                      accessibilityLabel={`${modalProps.title}|${modalProps.trailerStreamUrl ?? ''}`}
                    />
                  ) : null
                }
              />
            </PosterHoverPreviewProvider>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await fireEvent(screen.getByTestId('trigger-x:s1:movie:1-hover-container'), 'pointerEnter', {
      currentTarget: {
        getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    await fireEvent.press(screen.getByTestId('hover-preview-trailer'));
    expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
    expect(screen.getByTestId('detail-trailer-modal')).toBeTruthy();
    await view.unmount();

    // TV viewport is strict no-op
    const tvView = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <ViewportProvider value={{ formFactor: 'tv', width: 1920, height: 1080 }}>
            <PosterHoverPreviewProvider catalog={catalog} catalogRevision={1}>
              <TestCardTrigger />
              <PosterHoverPreviewHost onPlay={jest.fn()} onOpenDetail={jest.fn()} />
            </PosterHoverPreviewProvider>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );
    await fireEvent(screen.getByTestId('trigger-x:s1:movie:1'), 'hoverIn');
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS + 100);
    });
    expect(screen.queryByTestId('poster-hover-preview-card')).toBeNull();
    await tvView.unmount();
  });

  it('renders baseline entry overview before async hydration settles and blocks catalog dismissal fallback when allowDismissRecommendation is false', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const dismissCatalog = jest.fn(async () => undefined);
    const pendingCatalog = {
      itemDetail: jest.fn(() => new Promise<ItemDetailRow | null>(() => undefined)),
      getElvEnrichmentForKeys: jest.fn(() => new Promise(() => undefined)),
      dismissRecommendation: dismissCatalog,
    } as unknown as CatalogService;

    const view = await render(
      <I18nProvider i18n={createAppI18n('en')}>
        <ThemeProvider>
          <ViewportProvider
            value={{ formFactor: 'desktop', orientation: 'landscape', width: 1280, height: 800 }}
          >
            <PosterHoverPreviewProvider catalog={pendingCatalog} catalogRevision={1}>
              <TestCardTrigger
                itemKey="x:s1:movie:99"
                overview="Synchronous card overview before hydration settles."
                allowDismissRecommendation={false}
              />
              <PosterHoverPreviewHost onPlay={jest.fn()} onOpenDetail={jest.fn()} />
            </PosterHoverPreviewProvider>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>,
    );

    await fireEvent(screen.getByTestId('trigger-x:s1:movie:99-hover-container'), 'pointerEnter', {
      currentTarget: {
        getBoundingClientRect: () => ({ left: 200, top: 220, width: 170, height: 255 }),
      },
    });
    await act(async () => {
      jest.advanceTimersByTime(HOVER_PREVIEW_OPEN_DELAY_MS);
    });

    expect(screen.getByTestId('hover-preview-synopsis')).toHaveTextContent(
      'Synchronous card overview before hydration settles.',
    );
    expect(screen.queryByTestId('hover-preview-dismiss')).toBeNull();
    expect(dismissCatalog).not.toHaveBeenCalled();
    await view.unmount();
  });
});

import type { CatalogService } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { buildTheme, I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView, StyleSheet } from 'react-native';
import { DetailCastStrip } from '../DetailCastStrip';
import { DetailHero } from '../DetailHero';
import { DetailScreen } from '../DetailScreen';
import type { DetailVersionOption } from '../detail-data-helpers';
import {
  DETAIL_TRAILER_AUTOPLAY_DELAY_MS,
  DETAIL_TRAILER_PRELOAD_DELAY_MS,
} from '../detail-trailer-preview-model';

const defaultTheme = buildTheme();
const flat = StyleSheet.flatten;

function collectTestIds(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectTestIds(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown>; children?: unknown[] };
  if (typeof el.props?.testID === 'string') out.push(el.props.testID);
  if (Array.isArray(el.children)) {
    for (const child of el.children) collectTestIds(child, out);
  }
  return out;
}

const SHORT_SYNOPSIS =
  'An experienced archivist uncovers a long-forgotten reel of broadcast footage beneath a coastal lighthouse and begins restoring its missing frames.';

const LONG_SYNOPSIS =
  'In a quiet orbital listening station suspended above the twilight meridian, a veteran engineer uncovers a recurring signal hidden beneath decades of archived telemetry. As rival relays begin shutting down one by one, the crew must decide whether to broadcast the message back home or seal the beacon forever before orbit decays.';

const PRIMARY_ACTION = {
  kind: 'episode' as const,
  resume: false,
  season: 1,
  episodeNumber: 1,
  episode: { id: 1, key: 'ep:1:1', season: 1, episode: 1, title: 'Pilot', durationSec: 2700 },
  positionMs: 0,
  durationMs: 2_700_000,
  target: {
    itemKey: 'ep:1:1',
    sourceId: 's1',
    kind: 'vod' as const,
    itemKind: 'episode' as const,
    title: 'Spotlight Series — E1 · Pilot',
  },
};

const VERSIONS: readonly DetailVersionOption[] = [
  { key: 'm1', title: 'Spotlight Movie [4K]', versionLabel: '4K', year: 2026, qualityRank: 40 },
  {
    key: 'm2',
    title: 'Spotlight Movie [1080p]',
    versionLabel: '1080p',
    year: 2026,
    qualityRank: 30,
  },
];

describe('Wave R2-B Detail Hero Spotlight, Inline Synopsis Popover & Cast Strip', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aligns heroBottom to baseline, fits 6 48px circular buttons to exact 338px Play width in spotlight order', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.useFakeTimers();

    const onToggleDetailTrailerMuted = jest.fn();
    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1440,
          height: 900,
        }}
      >
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailHero
              kind="series"
              title="Spotlight Series"
              titleKey="series:1"
              backdropUri="https://img.example/backdrop.jpg"
              trailerStreamUrl="https://cdn.example.com/trailer.mp4"
              detailTrailerMuted
              trailerPreviewActive
              onToggleDetailTrailerMuted={onToggleDetailTrailerMuted}
              year={2026}
              rating={7.3}
              runtimeMin={48}
              genres={['Drama', 'Sci-Fi']}
              plot={SHORT_SYNOPSIS}
              seasonsCount={2}
              inMyList={false}
              userRating={null}
              watched={false}
              primaryAction={PRIMARY_ACTION}
              downloadState={{ icon: 'download', active: false, label: 'Download' }}
              onPressDownload={jest.fn()}
              onPressTrailer={jest.fn()}
              onToggleRating={jest.fn()}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait={false}
              topClearance={74}
              padX={24}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const heroBottomStyle = flat(screen.getByTestId('detail-hero-bottom').props.style);
    expect(heroBottomStyle.flexDirection).toBe('row');
    expect(heroBottomStyle.alignItems).toBe('flex-end');

    const actionsColStyle = flat(screen.getByTestId('detail-hero-actions').props.style);
    expect(actionsColStyle.width).toBe(338);

    const iconRowStyle = flat(screen.getByTestId('detail-hero-icon-row').props.style);
    expect(iconRowStyle.flexWrap).toBe('nowrap');
    expect(iconRowStyle.gap).toBe(10);

    // Exact button order: Trailer -> My List -> Like -> Dislike -> Watched -> Download
    const order = collectTestIds(view.toJSON());
    const idxTrailer = order.indexOf('detail-trailer');
    const idxMyList = order.indexOf('detail-mylist');
    const idxLike = order.indexOf('detail-like');
    const idxDislike = order.indexOf('detail-dislike');
    const idxWatched = order.indexOf('detail-watched');
    const idxDownload = order.indexOf('detail-download');
    expect(idxTrailer).toBeGreaterThan(-1);
    expect(idxTrailer).toBeLessThan(idxMyList);
    expect(idxMyList).toBeLessThan(idxLike);
    expect(idxLike).toBeLessThan(idxDislike);
    expect(idxDislike).toBeLessThan(idxWatched);
    expect(idxWatched).toBeLessThan(idxDownload);

    // Before 400ms preview returns null; during preload (before 2500ms) elevated mute anchor stays hidden
    expect(order.indexOf('detail-trailer-preview')).toBe(-1);
    expect(screen.queryByTestId('detail-trailer-mute-anchor')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_PRELOAD_DELAY_MS + 50);
    });
    expect(screen.getByTestId('detail-trailer-preview')).toBeTruthy();
    expect(screen.queryByTestId('detail-trailer-mute-anchor')).toBeNull();

    // Once playing begins, mute anchor renders OUTSIDE backdrop and AFTER foreground scrims/controls
    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS);
    });
    const activeOrder = collectTestIds(view.toJSON());
    const idxBackdropImg = activeOrder.indexOf('detail-hero-backdrop');
    const idxPreview = activeOrder.indexOf('detail-trailer-preview');
    const idxScrimTop = activeOrder.indexOf('detail-hero-scrim-top');
    const idxScrimBottom = activeOrder.indexOf('detail-hero-scrim-bottom');
    const idxPlayBtn = activeOrder.indexOf('detail-play');
    const idxMuteAnchor = activeOrder.indexOf('detail-trailer-mute-anchor');
    expect(idxBackdropImg).toBeGreaterThan(-1);
    expect(idxPreview).toBeGreaterThan(idxBackdropImg);
    expect(idxScrimTop).toBeGreaterThan(idxPreview);
    expect(idxScrimBottom).toBeGreaterThan(idxScrimTop);
    expect(idxMuteAnchor).toBeGreaterThan(idxScrimBottom);
    expect(idxMuteAnchor).toBeGreaterThan(idxPlayBtn);

    const muteAnchorStyle = flat(screen.getByTestId('detail-trailer-mute-anchor').props.style);
    expect(muteAnchorStyle.top).toBe(74 + 12);
    expect(muteAnchorStyle.right).toBe(24);
    expect(muteAnchorStyle.zIndex).toBeGreaterThanOrEqual(6);
    await fireEvent.press(screen.getByTestId('detail-trailer-mute-toggle'));
    expect(onToggleDetailTrailerMuted).toHaveBeenCalledTimes(1);

    // All 6 action IconButtons are 48x48 and reveal hover tooltip pills
    const actionIds = [
      'detail-trailer',
      'detail-mylist',
      'detail-like',
      'detail-dislike',
      'detail-watched',
      'detail-download',
    ];
    for (const id of actionIds) {
      const btnStyle = flat(screen.getByTestId(id).props.style);
      expect(btnStyle.width).toBe(48);
      expect(btnStyle.height).toBe(48);

      await fireEvent(screen.getByTestId(`${id}-tooltip`), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(330);
      });
      expect(screen.getByTestId(`${id}-tooltip-bubble`)).toBeTruthy();
      await fireEvent(screen.getByTestId(`${id}-tooltip`), 'pointerLeave');
    }

    // Enlarged primary Play CTA (width 100%, minHeight 54)
    const playStyle = flat(screen.getByTestId('detail-play').props.style);
    expect(playStyle.width).toBe('100%');
    expect(playStyle.minHeight).toBe(54);
    expect(playStyle.paddingVertical).toBe(14);

    // No multi-version dropdown when single version
    expect(screen.queryByTestId('detail-preplay-version-dropdown')).toBeNull();

    // Right column renders Synopsis above compact metadata row
    const idxMeta = activeOrder.indexOf('detail-hero-meta');
    const idxSynopsis = activeOrder.indexOf('detail-synopsis');
    const idxGenres = activeOrder.indexOf('detail-genres');
    const idxRating = activeOrder.indexOf('detail-rating');
    expect(idxSynopsis).toBeGreaterThan(idxMeta);
    expect(idxGenres).toBeGreaterThan(idxSynopsis);
    expect(idxRating).toBeGreaterThan(idxSynopsis);

    const synopsisStyle = flat(screen.getByTestId('detail-synopsis').props.style);
    expect(synopsisStyle.color).toBe(defaultTheme.colors.textPrimary);
    expect(synopsisStyle.maxWidth).toBe(660);

    // Short synopsis renders in full with ZERO see-more trigger
    expect(screen.getByTestId('detail-synopsis')).toHaveTextContent(SHORT_SYNOPSIS);
    expect(screen.queryByTestId('detail-synopsis-toggle')).toBeNull();

    await view.unmount();
  });

  it('positions Tooltip bubbles directly above all 6 action IconButtons (bottom: 100%)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.useFakeTimers();

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1440,
          height: 900,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <DetailHero
            kind="series"
            title="Tooltip Check"
            backdropUri={null}
            year={2026}
            rating={7.3}
            plot={SHORT_SYNOPSIS}
            seasonsCount={2}
            inMyList={false}
            watched={false}
            primaryAction={PRIMARY_ACTION}
            downloadState={{ icon: 'download', active: false, label: 'Download' }}
            onPressDownload={jest.fn()}
            onPressTrailer={jest.fn()}
            onToggleRating={jest.fn()}
            onBack={jest.fn()}
            onPlayPrimary={jest.fn()}
            onToggleMyList={jest.fn()}
            onToggleWatched={jest.fn()}
            isTv={false}
            isPortrait={false}
            topClearance={74}
            padX={24}
            focusedSlot={null}
          />
        </I18nProvider>
      </ViewportProvider>,
    );

    const actionIds = [
      'detail-trailer',
      'detail-mylist',
      'detail-like',
      'detail-dislike',
      'detail-watched',
      'detail-download',
    ];
    for (const id of actionIds) {
      await fireEvent(screen.getByTestId(`${id}-tooltip`), 'pointerEnter');
      await act(async () => {
        jest.advanceTimersByTime(330);
      });
      const bubbleStyle = flat(screen.getByTestId(`${id}-tooltip-bubble`).props.style);
      expect(bubbleStyle.bottom).toBe('100%');
      await fireEvent(screen.getByTestId(`${id}-tooltip`), 'pointerLeave');
    }

    await view.unmount();
  });

  it('places conditional full-width Version dropdown strictly below Play inside actionsCol when multiple versions exist', async () => {
    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailHero
              kind="movie"
              title="Spotlight Movie"
              backdropUri={null}
              year={2026}
              rating={8.1}
              plot={SHORT_SYNOPSIS}
              seasonsCount={0}
              inMyList={false}
              watched={false}
              primaryAction={{
                kind: 'movie',
                resume: false,
                positionMs: 0,
                durationMs: 0,
                target: { itemKey: 'm1', sourceId: 's1', kind: 'vod', title: 'Spotlight Movie' },
              }}
              versions={VERSIONS}
              activeVersionKey="m1"
              activeVersionLabel="4K"
              versionMenuOpen={false}
              onToggleVersionMenu={jest.fn()}
              onCloseVersionMenu={jest.fn()}
              onSelectVersion={jest.fn()}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait={false}
              topClearance={74}
              padX={24}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const serialized = JSON.stringify(view.toJSON());
    const idxPlay = serialized.indexOf('"detail-play"');
    const idxVersion = serialized.indexOf('"detail-preplay-version-dropdown"');
    const idxMeta = serialized.indexOf('"detail-hero-meta"');
    expect(idxVersion).toBeGreaterThan(idxPlay);
    expect(idxVersion).toBeLessThan(idxMeta);

    const versionTriggerStyle = flat(screen.getByTestId('detail-preplay-version').props.style);
    expect(versionTriggerStyle.width).toBe('100%');
    expect(versionTriggerStyle.minHeight).toBe(48);

    await view.unmount();
  });

  it('scales 6 action icons smoothly on narrow portrait (< 370px) without overflowing', async () => {
    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'phone',
          orientation: 'portrait',
          inputModality: 'touch',
          width: 350,
          height: 760,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailHero
              kind="movie"
              title="Compact Portrait"
              backdropUri={null}
              year={2026}
              rating={7.9}
              plot="Short plot."
              seasonsCount={0}
              inMyList={false}
              watched={false}
              primaryAction={{
                kind: 'movie',
                resume: false,
                positionMs: 0,
                durationMs: 0,
                target: { itemKey: 'm1', sourceId: 's1', kind: 'vod', title: 'Compact Portrait' },
              }}
              downloadState={{ icon: 'download', active: false, label: 'Download' }}
              onPressDownload={jest.fn()}
              onPressTrailer={jest.fn()}
              onToggleRating={jest.fn()}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait
              topClearance={60}
              padX={16}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const iconRowStyle = flat(screen.getByTestId('detail-hero-icon-row').props.style);
    expect(iconRowStyle.justifyContent).toBe('space-between');
    expect(iconRowStyle.flexWrap).toBe('nowrap');
    expect(flat(screen.getByTestId('detail-trailer').props.style).width).toBe(44);
    expect(flat(screen.getByTestId('detail-download').props.style).width).toBe(44);

    await view.unmount();
  });

  it('renders inline underlined see more... on overflowing synopsis and opens/dismisses floating popover above synopsis on desktop (and sheet on portrait)', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const listeners = new Map<string, Set<(ev: unknown) => void>>();
    const prevWindow = (globalThis as { window?: unknown }).window;
    const winStub = {
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (ev: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    Object.defineProperty(globalThis, 'window', { value: winStub, configurable: true });

    try {
      const catalog = {
        itemDetail: jest.fn(async () => null),
        listFavoriteKeys: jest.fn(async () => []),
        getProgress: jest.fn(async () => null),
        itemVersions: jest.fn(async () => []),
        categories: jest.fn(async () => []),
        items: jest.fn(async () => []),
        listProgressByKeys: jest.fn(async () => []),
        getRating: jest.fn(async () => null),
      } as unknown as CatalogService;

      const target = {
        itemKey: 'm:long',
        sourceId: 's1',
        kind: 'movie' as const,
        title: 'Long Synopsis Movie',
        posterUri: null,
        backdropUri: null,
        year: 2026,
        rating: 8.2,
        overview: LONG_SYNOPSIS,
      };

      const desktopView = await render(
        <ViewportProvider
          value={{
            formFactor: 'desktop',
            orientation: 'landscape',
            inputModality: 'pointer',
            width: 1280,
            height: 800,
          }}
        >
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <DetailScreen
                target={target}
                catalog={catalog}
                refreshToken={1}
                onBack={jest.fn()}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('detail-synopsis-toggle')).toBeTruthy();
      });
      const toggle = screen.getByTestId('detail-synopsis-toggle');
      expect(toggle).toHaveTextContent('see more...');
      expect(flat(toggle.props.style).textDecorationLine).toBe('underline');

      // Clicking opens floating popover directly above synopsis (NOT AdaptiveSheet)
      await fireEvent.press(toggle);
      const popover = screen.getByTestId('detail-synopsis-popover');
      expect(screen.queryByTestId('detail-synopsis-sheet')).toBeNull();
      const popoverStyle = flat(popover.props.style);
      expect(popoverStyle.position).toBe('absolute');
      expect(popoverStyle.bottom).toBe('100%');
      expect(popoverStyle.left).toBe(0);
      expect(popoverStyle.marginBottom).toBe(10);
      expect(popoverStyle.maxWidth).toBe(560);
      expect(screen.getByTestId('detail-synopsis-full')).toHaveTextContent(LONG_SYNOPSIS);

      // Escape dismisses popover
      await act(async () => {
        for (const fn of listeners.get('keydown') ?? []) fn({ key: 'Escape' });
      });
      expect(screen.queryByTestId('detail-synopsis-popover')).toBeNull();

      // Re-open and click-outside backdrop dismisses popover
      await fireEvent.press(screen.getByTestId('detail-synopsis-toggle'));
      expect(screen.getByTestId('detail-synopsis-popover')).toBeTruthy();
      await fireEvent.press(
        screen.getByTestId('detail-synopsis-popover-backdrop', { includeHiddenElements: true }),
      );
      expect(screen.queryByTestId('detail-synopsis-popover')).toBeNull();

      await desktopView.unmount();

      // On Portrait mobile, opens AdaptiveSheet instead of anchored popover
      const portraitView = await render(
        <ViewportProvider
          value={{
            formFactor: 'phone',
            orientation: 'portrait',
            inputModality: 'touch',
            width: 390,
            height: 844,
          }}
        >
          <ThemeProvider>
            <I18nProvider i18n={createAppI18n('en')}>
              <DetailScreen
                target={target}
                catalog={catalog}
                refreshToken={1}
                onBack={jest.fn()}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('detail-synopsis-toggle')).toBeTruthy();
      });
      await fireEvent.press(screen.getByTestId('detail-synopsis-toggle'));
      expect(screen.getByTestId('detail-synopsis-sheet')).toBeTruthy();
      expect(screen.queryByTestId('detail-synopsis-popover')).toBeNull();
      await portraitView.unmount();
    } finally {
      Object.defineProperty(globalThis, 'window', { value: prevWindow, configurable: true });
    }
  });

  it('renders DetailCastStrip horizontally scrollable directly below hero/synopsis and auto-scrolls on TV focus', async () => {
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);

    const cast = Array.from({ length: 12 }, (_, idx) => ({
      name: `Actor ${idx + 1}`,
      role: `Role ${idx + 1}`,
      avatarUri: `https://img.example/actor-${idx}.jpg`,
    }));

    const view = await render(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>
            <DetailCastStrip
              cast={cast}
              padX={48}
              isTv
              focusedIndex={6}
              onSelectPerson={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const stripRootStyle = flat(screen.getByTestId('detail-cast').props.style);
    expect(stripRootStyle.marginTop).toBe(defaultTheme.spacing.md);
    const scrollEl = screen.getByTestId('detail-cast-strip-scroll');
    expect(scrollEl.props.horizontal).toBe(true);
    expect(scrollToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ x: expect.any(Number), animated: true }),
    );
    await view.unmount();
  });
});

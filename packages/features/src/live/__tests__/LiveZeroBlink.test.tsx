import type {
  CatalogService,
  CategoryRow,
  ItemRow,
  NowNextEntry,
  ProgrammeRow,
  SourceRow,
} from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import {
  type CatalogLayoutMetrics,
  CatalogUiCacheProvider,
  createCatalogUiCache,
  type DisplayCategory,
} from '../../shared';
import { EpgGridView } from '../EpgGridView';
import { LiveChannelsGrid } from '../LiveChannelsGrid';
import { LiveScreen } from '../LiveScreen';
import { LiveZapDrawer } from '../LiveZapDrawer';
import { createStaticPagedListSource } from '../live-model';

const SOURCE: SourceRow = {
  id: 'src-1',
  kind: 'xtream',
  name: 'Demo',
  createdAt: 100,
  needsImport: false,
};

const LIVE_CAT: CategoryRow = {
  id: 'src-1|live|news',
  sourceId: 'src-1',
  kind: 'live',
  name: 'News',
  position: 0,
  itemCount: 30,
};

function makeChannels(count: number): ItemRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    key: `x:src-1:live:${i + 1}`,
    sourceId: 'src-1',
    providerId: String(i + 1),
    kind: 'live',
    name: `Channel ${i + 1}`,
    logo: null,
    rating: null,
    year: null,
    num: i + 1,
  }));
}

function makeLayout(isTv: boolean): CatalogLayoutMetrics {
  return {
    isTv,
    isPortrait: false,
    isTouch: false,
    padX: 24,
    railGap: 14,
    gridGap: 14,
    heroTopClearance: 64,
    posterRailWidth: 160,
    wideRailWidth: 280,
    gridColumns: 4,
    gridCardWidth: 160,
    gridRowHeight: 200,
    visibleGridRows: 4,
  };
}

describe('Live TV zero-blink CatalogUiCache hydration, setFavorite & tvOS edge fades (#445, #230)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hydrates Live categories, channels, Now/Next, and EPG window synchronously from CatalogUiCache and calls setFavorite', async () => {
    const channels = makeChannels(30);
    const firstChannel = channels[0];
    if (!firstChannel) throw new Error('expected channel');
    const nowMs = 1_700_000_000_000;
    const prog: ProgrammeRow = {
      sourceId: 'src-1',
      guideId: 'g-1',
      channelKey: firstChannel.key,
      start: nowMs - 600_000,
      stop: nowMs + 1_200_000,
      title: 'Evening Bulletin',
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
      genre: null,
      flags: 0,
    };
    const nowNextEntry: NowNextEntry = {
      channelKey: firstChannel.key,
      now: prog,
      next: null,
    };

    const setFavoriteMock = jest.fn(async (_input, active: boolean) => ok(active));
    const catalog = {
      categories: jest.fn(async () => [LIVE_CAT]),
      items: jest.fn(async () => channels),
      listFavoriteKeys: jest.fn(async () => []),
      listFavorites: jest.fn(async () => []),
      nowNext: jest.fn(async () => [nowNextEntry]),
      epgWindow: jest.fn(async () => ({ [firstChannel.key]: [prog] })),
      setFavorite: setFavoriteMock,
      toggleFavorite: jest.fn(async () => ok(true)),
    } as unknown as CatalogService;

    const uiCache = createCatalogUiCache({ locale: 'en' });
    const wrap = (ui: React.ReactElement) => (
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
            <CatalogUiCacheProvider cache={uiCache}>{ui}</CatalogUiCacheProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(
      wrap(
        <LiveScreen
          catalog={catalog}
          sources={[SOURCE]}
          refreshToken={1}
          nowMs={nowMs}
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByText('Channel 1')).toBeTruthy();
      expect(screen.getByText('Evening Bulletin')).toBeTruthy();
    });

    // Toggle favorite uses catalog.setFavorite(input, true)
    await fireEvent.press(screen.getByTestId('live-channel-fav-0'));
    expect(setFavoriteMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: firstChannel.key }),
      true,
    );

    // Switch to EPG mode so EPG window populates uiCache
    await fireEvent.press(screen.getByTestId('live-mode-epg'));
    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
      expect(screen.getAllByText('Evening Bulletin').length).toBeGreaterThan(0);
    });
    await view.unmount();

    // Remount with blocked catalog reads -> hydrates synchronously on frame 0 with ZERO skeleton!
    const blockedCatalog = {
      categories: jest.fn(() => new Promise(() => undefined)),
      items: jest.fn(() => new Promise(() => undefined)),
      listFavoriteKeys: jest.fn(() => new Promise(() => undefined)),
      listFavorites: jest.fn(() => new Promise(() => undefined)),
      nowNext: jest.fn(() => new Promise(() => undefined)),
      epgWindow: jest.fn(() => new Promise(() => undefined)),
    } as unknown as CatalogService;

    const warmView = await render(
      wrap(
        <LiveScreen
          catalog={blockedCatalog}
          sources={[SOURCE]}
          refreshToken={1}
          nowMs={nowMs}
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
        />,
      ),
    );
    expect(screen.queryByTestId('live-loading-skeleton')).toBeNull();
    expect(screen.getByText('Channel 1')).toBeTruthy();
    expect(screen.getByText('Evening Bulletin')).toBeTruthy();
    await warmView.unmount();
  });

  it('renders TvScrollEdgeFade on LiveChannelsGrid, EpgGridView, and LiveZapDrawer TV viewports on tvOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const channels = makeChannels(40);
    const source = createStaticPagedListSource(channels);
    const displayCat: DisplayCategory = { row: LIVE_CAT, label: LIVE_CAT.name };
    const layout = makeLayout(true);

    const wrapTv = (ui: React.ReactElement) => (
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
          <I18nProvider i18n={createAppI18n('en')}>{ui}</I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const channelsView = await render(
      wrapTv(
        <LiveChannelsGrid
          channelSource={source}
          sourceVersion={1}
          nowNextByKey={new Map()}
          nowNextVersion={0}
          activeChannelKey={null}
          layout={layout}
          hydrateNowNext={jest.fn()}
          onWatchChannel={jest.fn()}
          isActiveScope
        />,
      ),
    );
    expect(screen.getByTestId('live-channels-edge-fade-bottom')).toBeTruthy();
    expect(screen.queryByTestId('live-channels-edge-fade-top')).toBeNull();
    await channelsView.unmount();

    const zapView = await render(
      wrapTv(
        <LiveZapDrawer
          channelSource={source}
          sourceVersion={1}
          nowNextByKey={new Map()}
          nowNextVersion={0}
          activeChannelKey={null}
          focusedZapIndex={10}
          layout={layout}
          hydrateNowNext={jest.fn()}
          onSelectChannel={jest.fn()}
        />,
      ),
    );
    expect(screen.getByTestId('live-zap-edge-fade-top')).toBeTruthy();
    expect(screen.getByTestId('live-zap-edge-fade-bottom')).toBeTruthy();
    await zapView.unmount();

    const epgView = await render(
      wrapTv(
        <EpgGridView
          catalog={{ epgWindow: jest.fn(async () => ({})) } as unknown as CatalogService}
          category={displayCat}
          channelSource={source}
          sourceVersion={1}
          refreshToken={1}
          nowMs={1_700_000_000_000}
          onWatchChannel={jest.fn()}
          isActiveScope
        />,
      ),
    );
    expect(screen.getByTestId('epg-grid-edge-fade-bottom')).toBeTruthy();
    expect(screen.queryByTestId('epg-grid-edge-fade-top')).toBeNull();
    await epgView.unmount();
  });
});

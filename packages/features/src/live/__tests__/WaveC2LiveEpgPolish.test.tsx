import type { CatalogService, ItemRow, ProgrammeRow } from '@elv/data';
import { EPG_FLAG_LIVE, EPG_FLAG_NEW, EPG_FLAG_PREMIERE } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  buildTheme,
  createTvRemoteDispatcher,
  FormFactorProvider,
  I18nProvider,
  ThemeProvider,
  TvRemoteContext,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { EpgGridView } from '../EpgGridView';
import { EpgProgrammeDetailModal } from '../EpgProgrammeDetailModal';
import { LiveContextMenu } from '../LiveContextMenu';
import { LiveScreen } from '../LiveScreen';
import { createStaticPagedListSource } from '../live-model';

const NOW_MS = new Date(2026, 4, 15, 18, 15, 0, 0).getTime(); // 18:15 local
const H = 3_600_000;
const M = 60_000;

const CHANNELS: readonly ItemRow[] = [
  {
    id: 1,
    key: 'x:s1:live:1',
    kind: 'live',
    sourceId: 's1',
    providerId: '1',
    name: 'Sports One',
    logo: null,
    rating: null,
    year: null,
    num: 1,
  },
  {
    id: 2,
    key: 'x:s1:live:2',
    kind: 'live',
    sourceId: 's1',
    providerId: '2',
    name: 'Cinema HD',
    logo: null,
    rating: null,
    year: null,
    num: 2,
  },
];

const PROG_CLIPPED_LIVE: ProgrammeRow = {
  channelKey: 'x:s1:live:1',
  sourceId: 's1',
  guideId: 'g1',
  start: NOW_MS - 45 * M, // started before 18:00 window -> clippedStart === true
  stop: NOW_MS + 45 * M, // 90m -> wide cell
  title: 'Championship Final',
  subTitle: 'Second Half',
  description: 'Live stadium broadcast',
  episodeNum: null,
  icon: null,
  genre: 'sports',
  flags: EPG_FLAG_LIVE | EPG_FLAG_NEW,
};

const PROG_NARROW_UPCOMING: ProgrammeRow = {
  channelKey: 'x:s1:live:1',
  sourceId: 's1',
  guideId: 'g1',
  start: NOW_MS + 45 * M,
  stop: NOW_MS + 55 * M, // 10m -> ultra-narrow (< 0.14 widthRatio)
  title: 'Flash Update',
  subTitle: null,
  description: null,
  episodeNum: null,
  icon: null,
  genre: 'news',
  flags: EPG_FLAG_PREMIERE,
};

const PROG_UPCOMING_FEATURE: ProgrammeRow = {
  channelKey: 'x:s1:live:1',
  sourceId: 's1',
  guideId: 'g1',
  start: NOW_MS + 60 * M,
  stop: NOW_MS + 2 * H,
  title: 'Night Premiere',
  subTitle: 'Episode 1',
  description: 'Full synopsis for upcoming premiere.',
  episodeNum: 'S1 E1',
  icon: null,
  genre: 'movie',
  flags: EPG_FLAG_PREMIERE,
};

function wrap(node: ReactElement) {
  return (
    <ThemeProvider preset="obsidianCrimson">
      <I18nProvider i18n={createAppI18n('en')}>
        <FormFactorProvider value="desktop">
          <ViewportProvider
            value={{
              formFactor: 'desktop',
              orientation: 'landscape',
              inputModality: 'pointer',
              width: 1280,
              height: 720,
            }}
          >
            {node}
          </ViewportProvider>
        </FormFactorProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}

function makeCatalog(): CatalogService {
  return {
    listSources: jest.fn(async () => [
      { id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false },
    ]),
    categories: jest.fn(async () => [
      { id: 's1|live|1', sourceId: 's1', kind: 'live', name: 'All', itemCount: CHANNELS.length },
    ]),
    items: jest.fn(async () => [...CHANNELS]),
    nowNext: jest.fn(async () => [
      { channelKey: 'x:s1:live:1', now: PROG_CLIPPED_LIVE, next: PROG_UPCOMING_FEATURE },
    ]),
    epgWindow: jest.fn(async () => ({
      'x:s1:live:1': [PROG_CLIPPED_LIVE, PROG_NARROW_UPCOMING, PROG_UPCOMING_FEATURE],
      'x:s1:live:2': [],
    })),
    listFavoriteKeys: jest.fn(async () => ['x:s1:live:1']),
    listFavorites: jest.fn(async () => []),
    toggleFavorite: jest.fn(async () => ({ ok: true as const, value: true })),
    setFavorite: jest.fn(async () => ({ ok: true as const, value: true })),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
}

describe('Wave C2 Live & EPG Polish (#52, #395, #396, #400)', () => {
  it('renders clipped-start indicator, genre tints, badges on wide cells only, multi-day date tabs, and upcoming programme detail modal (#395, #396)', async () => {
    const catalog = makeCatalog();
    const onWatchChannel = jest.fn();
    const onToggleFavorite = jest.fn();
    const channelSource = createStaticPagedListSource(CHANNELS);
    const theme = buildTheme({ preset: 'obsidianCrimson' });

    await render(
      wrap(
        <EpgGridView
          catalog={catalog}
          category={{
            row: {
              id: 's1|live|1',
              sourceId: 's1',
              kind: 'live',
              name: 'All',
              position: 0,
              itemCount: 2,
            },
            label: 'All',
          }}
          channelSource={channelSource}
          sourceVersion={1}
          refreshToken={0}
          nowMs={NOW_MS}
          favoriteKeys={new Set(['x:s1:live:1'])}
          onWatchChannel={onWatchChannel}
          onToggleFavorite={onToggleFavorite}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-0-0')).toBeTruthy();
    });

    // Clipped-start leading continuation marker on slot 0
    expect(screen.getByTestId('epg-cell-clipped-0-0')).toBeTruthy();

    // Wide slot 0 shows Live/New badges; ultra-narrow slot 1 hides badges so title stays legible
    expect(screen.getByTestId('epg-cell-badge-0-0-live')).toBeTruthy();
    expect(screen.queryByTestId('epg-cell-badge-0-1-premiere')).toBeNull();

    // Preview header shows decoded Live/New badges for focused programme
    expect(screen.getByTestId('epg-preview-badge-live')).toBeTruthy();
    expect(screen.getByTestId('epg-preview-badge-new')).toBeTruthy();

    // Genre tint on upcoming movie cell (slot 2) uses O(1) genre -> accent color
    const movieStyle = StyleSheet.flatten(screen.getByTestId('epg-cell-0-2').props.style);
    expect(movieStyle.borderLeftColor).toBe(theme.colors.accent);

    // Multi-day date tabs render Today, Tomorrow, and +6d
    expect(screen.getByTestId('epg-date-tab-0')).toBeTruthy();
    expect(screen.getByTestId('epg-date-tab-1')).toBeTruthy();
    expect(screen.getByTestId('epg-date-tab-6')).toBeTruthy();

    // Pressing upcoming programme cell opens in-tree EpgProgrammeDetailModal (not immediate tune)
    await fireEvent.press(screen.getByTestId('epg-cell-0-2'));
    expect(onWatchChannel).not.toHaveBeenCalled();
    expect(screen.getByTestId('epg-programme-detail-modal')).toBeTruthy();
    expect(screen.getByTestId('epg-detail-title').props.children).toBe('Night Premiere');
    expect(screen.getByText('S1 E1')).toBeTruthy();
    expect(screen.getByTestId('epg-detail-badge-premiere')).toBeTruthy();

    // Tune CTA inside modal tunes channel and closes modal
    await fireEvent.press(screen.getByTestId('epg-detail-tune'));
    expect(onWatchChannel).toHaveBeenCalledWith(CHANNELS[0], 0);
    expect(screen.queryByTestId('epg-programme-detail-modal')).toBeNull();
  });

  it('opens LiveContextMenu on long-press without firing Play and routes to Programme details (#400)', async () => {
    const catalog = makeCatalog();
    const onPlay = jest.fn();

    await render(
      wrap(
        <LiveScreen
          catalog={catalog}
          sources={[{ id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false }]}
          refreshToken={0}
          nowMs={NOW_MS}
          defaultLiveMode="channels"
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // Long-press opens context menu without firing primary Play
    await act(async () => {
      fireEvent(screen.getByTestId('live-channel-card-0'), 'longPress');
    });
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-context-menu')).toBeTruthy();
    expect(screen.getByTestId('live-context-play')).toBeTruthy();
    expect(screen.getByTestId('live-context-favorite')).toBeTruthy();

    // Selecting Play inside context menu tunes channel and closes menu
    await fireEvent.press(screen.getByTestId('live-context-play'));
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('live-context-menu')).toBeNull();
  });

  it('shows Previous channel trigger in Channels and TV Guide modes but strictly omits it in Favorites (#52)', async () => {
    const catalog = makeCatalog();
    const onPlay = jest.fn();

    const view = await render(
      wrap(
        <LiveScreen
          catalog={catalog}
          sources={[{ id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false }]}
          refreshToken={0}
          nowMs={NOW_MS}
          memory={{
            mode: 'channels',
            categoryId: 's1|live|1',
            activeChannelKey: 'x:s1:live:2',
            previousChannelKey: 'x:s1:live:1',
            zapDrawerOpen: false,
          }}
          onMemoryChange={jest.fn()}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-previous-channel-btn')).toBeTruthy();
    });

    // Switching to Favorites strictly omits Previous channel button (UI_UX_PHILOSOPHY.md §2.1)
    await view.rerender(
      wrap(
        <LiveScreen
          catalog={catalog}
          sources={[{ id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false }]}
          refreshToken={0}
          nowMs={NOW_MS}
          memory={{
            mode: 'favorites',
            categoryId: 's1|live|1',
            activeChannelKey: 'x:s1:live:2',
            previousChannelKey: 'x:s1:live:1',
            zapDrawerOpen: false,
          }}
          onMemoryChange={jest.fn()}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      ),
    );
    expect(screen.queryByTestId('live-previous-channel-btn')).toBeNull();
  });

  it('handles tvOS/BackHandler action:press for back and select in EpgProgrammeDetailModal and LiveContextMenu (#395, #400)', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const onCloseDetail = jest.fn();
    const onTuneChannel = jest.fn();
    const ch = CHANNELS[0];
    if (!ch) throw new Error('missing channel');

    const detailView = await render(
      <TvRemoteContext.Provider value={dispatcher}>
        {wrap(
          <EpgProgrammeDetailModal
            visible
            channel={ch}
            channelIndex={0}
            programme={PROG_CLIPPED_LIVE}
            nowMs={NOW_MS}
            isFavorite={false}
            isTv
            onTuneChannel={onTuneChannel}
            onClose={onCloseDetail}
          />,
        )}
      </TvRemoteContext.Provider>,
    );

    // Localized genre badge (never raw lowercase 'sports')
    expect(screen.getByTestId('epg-detail-genre')).toBeTruthy();
    expect(screen.getByText('Sports')).toBeTruthy();
    expect(screen.queryByText('sports')).toBeNull();

    // Releasing select ('up') must NOT trigger tune
    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'up', time: 0 }, false);
    });
    expect(onTuneChannel).not.toHaveBeenCalled();

    // tvOS/BackHandler action: 'press' for back closes modal
    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 0 }, false);
    });
    expect(onCloseDetail).toHaveBeenCalledTimes(1);

    // tvOS action: 'press' for select triggers primary tune action
    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'press', time: 0 }, false);
    });
    expect(onTuneChannel).toHaveBeenCalledWith(ch, 0);
    await detailView.unmount();

    const onCloseMenu = jest.fn();
    const onPlay = jest.fn();
    const onHideChannel = jest.fn();
    const menuView = await render(
      <TvRemoteContext.Provider value={dispatcher}>
        {wrap(
          <LiveContextMenu
            visible
            channel={ch}
            channelIndex={0}
            programme={PROG_CLIPPED_LIVE}
            isFavorite={false}
            isTv
            onPlay={onPlay}
            onHideChannel={onHideChannel}
            onClose={onCloseMenu}
          />,
        )}
      </TvRemoteContext.Provider>,
    );

    // Hide channel uses dedicated localized label, never 'Close'
    expect(screen.getByText('Hide channel')).toBeTruthy();

    await act(async () => {
      dispatcher.dispatch({ key: 'back', action: 'press', time: 0 }, false);
    });
    expect(onCloseMenu).toHaveBeenCalledTimes(1);

    await act(async () => {
      dispatcher.dispatch({ key: 'select', action: 'press', time: 0 }, false);
    });
    expect(onPlay).toHaveBeenCalledWith(ch, 0);
    await menuView.unmount();
  });

  it('opens LiveContextMenu from Favorites zap drawer on TV Menu key and handles lastChannel in Live header (#400, #52)', async () => {
    const dispatcher = createTvRemoteDispatcher();
    const catalog = makeCatalog();
    const onPlay = jest.fn();

    const view = await render(
      <TvRemoteContext.Provider value={dispatcher}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <FormFactorProvider value="tv">
              <ViewportProvider
                value={{
                  formFactor: 'tv',
                  orientation: 'landscape',
                  width: 1920,
                  height: 1080,
                }}
              >
                <LiveScreen
                  catalog={catalog}
                  sources={[
                    { id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false },
                  ]}
                  refreshToken={0}
                  nowMs={NOW_MS}
                  isActiveScope
                  memory={{
                    mode: 'channels',
                    categoryId: 's1|live|1',
                    activeChannelKey: 'x:s1:live:2',
                    previousChannelKey: 'x:s1:live:1',
                    zapDrawerOpen: true,
                  }}
                  onMemoryChange={jest.fn()}
                  onPlay={onPlay}
                  onOpenSources={jest.fn()}
                />
              </ViewportProvider>
            </FormFactorProvider>
          </I18nProvider>
        </ThemeProvider>
      </TvRemoteContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // TV focus starts in Live header; pressing lastChannel in Channels mode jumps to previous channel (#52)
    await act(async () => {
      dispatcher.dispatch({ key: 'lastChannel', action: 'press', time: 0 }, false);
    });
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'x:s1:live:1' }));

    // Switch to Favorites with zapDrawerOpen: true, navigate to zap drawer, press Menu -> opens context menu (#400)
    const ch0 = CHANNELS[0];
    if (!ch0) throw new Error('missing ch0');
    (catalog.listFavorites as jest.Mock).mockResolvedValue([
      {
        itemKey: ch0.key,
        sourceId: ch0.sourceId,
        kind: 'live',
        title: ch0.name,
        poster: null,
        addedAt: 1,
      },
    ]);
    await view.rerender(
      <TvRemoteContext.Provider value={dispatcher}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <FormFactorProvider value="tv">
              <ViewportProvider
                value={{
                  formFactor: 'tv',
                  orientation: 'landscape',
                  width: 1920,
                  height: 1080,
                }}
              >
                <LiveScreen
                  catalog={catalog}
                  sources={[
                    { id: 's1', kind: 'xtream', name: 'Demo', createdAt: 1, needsImport: false },
                  ]}
                  refreshToken={1}
                  nowMs={NOW_MS}
                  isActiveScope
                  memory={{
                    mode: 'favorites',
                    categoryId: 's1|live|1',
                    activeChannelKey: ch0.key,
                    previousChannelKey: 'x:s1:live:2',
                    zapDrawerOpen: true,
                  }}
                  onMemoryChange={jest.fn()}
                  onPlay={onPlay}
                  onOpenSources={jest.fn()}
                />
              </ViewportProvider>
            </FormFactorProvider>
          </I18nProvider>
        </ThemeProvider>
      </TvRemoteContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-zap-drawer')).toBeTruthy();
    });

    // lastChannel must NOT trigger in Favorites mode
    const playCallsBefore = onPlay.mock.calls.length;
    await act(async () => {
      dispatcher.dispatch({ key: 'lastChannel', action: 'press', time: 0 }, false);
    });
    expect(onPlay.mock.calls.length).toBe(playCallsBefore);

    // Navigate from header -> body controls -> zap drawer, then press Menu
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 0 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'down', action: 'press', time: 0 }, false);
    });
    await act(async () => {
      dispatcher.dispatch({ key: 'menu', action: 'press', time: 0 }, false);
    });
    await waitFor(() => {
      expect(screen.getByTestId('live-context-menu')).toBeTruthy();
    });
    await view.unmount();
  });
});

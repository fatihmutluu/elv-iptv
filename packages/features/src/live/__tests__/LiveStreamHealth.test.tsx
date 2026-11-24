import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createIdleProbeController,
  createStreamHealthCache,
  type StreamRequest,
} from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { VideoHost } from '../../ports/video-host';
import { StreamHealthProvider } from '../../shared';
import { ChannelGridTile, type LiveGridShared } from '../LiveChannelTile';
import { LiveScreen } from '../LiveScreen';
import { ZapChannelRow } from '../LiveZapRow';
import { useLiveEmbeddedPreview } from '../useLiveEmbeddedPreview';

const DEMO_SOURCE: SourceRow = {
  id: 's1',
  kind: 'xtream',
  name: 'Primary IPTV',
  createdAt: 1,
  needsImport: false,
};

function makeChannel(index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: index,
    key: `x:s1:live:${index}`,
    kind: 'live',
    sourceId: 's1',
    providerId: String(index),
    name: `Channel ${index}`,
    logo: null,
    rating: null,
    year: null,
    num: index,
    ...overrides,
  };
}

function wrapWithHealth(
  node: ReactElement,
  health?: {
    readonly healthCache?: ReturnType<typeof createStreamHealthCache>;
    readonly idleProbeController?: ReturnType<typeof createIdleProbeController>;
  },
): ReactElement {
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 720,
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">
            <StreamHealthProvider
              {...(health?.healthCache !== undefined ? { healthCache: health.healthCache } : {})}
              {...(health?.idleProbeController !== undefined
                ? { idleProbeController: health.idleProbeController }
                : {})}
            >
              {node}
            </StreamHealthProvider>
          </ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

const SHARED_GRID: LiveGridShared = {
  cols: 2,
  cardHeight: 88,
  rowHeight: 96,
  gap: 8,
  padX: 16,
  isTv: false,
  isTouch: false,
  liveBadge: 'LIVE',
  upNext: 'Next',
  noProgram: 'No programme info',
  favoriteAdd: 'Add to favorites',
  favoriteRemove: 'Remove from favorites',
};

describe('Live passive stream health badges & idle-probe abort on navigation (#167)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders passive health micro-badges ONLY for flaky/dead channels and NEVER for healthy/unknown channels', async () => {
    const healthCache = createStreamHealthCache();
    const chUnknown = makeChannel(1);
    const chHealthy = makeChannel(2);
    const chFlaky = makeChannel(3);
    const chDead = makeChannel(4);

    healthCache.recordSuccess(chHealthy.key, 420);
    healthCache.recordFailure(chFlaky.key, false);
    healthCache.recordFailure(chDead.key, true);

    await render(
      wrapWithHealth(
        <View>
          <ChannelGridTile
            item={chUnknown}
            itemIndex={0}
            nowNext={undefined}
            nowMs={10_000}
            shared={SHARED_GRID}
            isActive={false}
            isFavorite={false}
            focused={false}
            onWatchChannel={jest.fn()}
          />
          <ChannelGridTile
            item={chHealthy}
            itemIndex={1}
            nowNext={undefined}
            nowMs={10_000}
            shared={SHARED_GRID}
            isActive={false}
            isFavorite={false}
            focused={false}
            onWatchChannel={jest.fn()}
          />
          <ChannelGridTile
            item={chFlaky}
            itemIndex={2}
            nowNext={undefined}
            nowMs={10_000}
            shared={SHARED_GRID}
            isActive={false}
            isFavorite={false}
            focused={false}
            onWatchChannel={jest.fn()}
          />
          <ChannelGridTile
            item={chDead}
            itemIndex={3}
            nowNext={undefined}
            nowMs={10_000}
            shared={SHARED_GRID}
            isActive={false}
            isFavorite={false}
            focused={false}
            onWatchChannel={jest.fn()}
          />
          <ZapChannelRow
            index={0}
            item={chHealthy}
            nowTitle={null}
            noProgramLabel="No info"
            rowHeight={56}
            isActive={false}
            isTv={false}
            isTouch={false}
            focused={false}
            onSelectChannel={jest.fn()}
          />
          <ZapChannelRow
            index={1}
            item={chFlaky}
            nowTitle={null}
            noProgramLabel="No info"
            rowHeight={56}
            isActive={false}
            isTv={false}
            isTouch={false}
            focused={false}
            onSelectChannel={jest.fn()}
          />
          <ZapChannelRow
            index={2}
            item={chDead}
            nowTitle={null}
            noProgramLabel="No info"
            rowHeight={56}
            isActive={false}
            isTv={false}
            isTouch={false}
            focused={false}
            onSelectChannel={jest.fn()}
          />
        </View>,
        { healthCache },
      ),
    );

    expect(screen.queryByTestId('live-channel-health-0')).toBeNull();
    expect(screen.queryByTestId('live-channel-health-1')).toBeNull();
    expect(screen.queryByTestId('live-zap-health-0')).toBeNull();

    expect(screen.getByTestId('live-channel-health-2')).toHaveTextContent('Unstable');
    expect(screen.getByTestId('live-channel-health-3')).toHaveTextContent('Offline');
    expect(screen.getByTestId('live-zap-health-1')).toHaveTextContent('Unstable');
    expect(screen.getByTestId('live-zap-health-2')).toHaveTextContent('Offline');

    await act(async () => {
      healthCache.recordSuccess(chFlaky.key, 300);
    });
    expect(screen.queryByTestId('live-channel-health-2')).toBeNull();
    expect(screen.queryByTestId('live-zap-health-1')).toBeNull();
  });

  it('aborts idle probes on live category and mode navigation', async () => {
    const idleProbeController = createIdleProbeController();
    const probeSignal = idleProbeController.beginProbe({ maxConnections: 2 });
    expect(probeSignal).not.toBeNull();
    expect(probeSignal?.aborted).toBe(false);

    const catalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => [
        {
          id: 's1|live|sports',
          sourceId: 's1',
          kind: 'live',
          name: 'Sports',
          position: 0,
          itemCount: 1,
        },
        {
          id: 's1|live|news',
          sourceId: 's1',
          kind: 'live',
          name: 'News',
          position: 1,
          itemCount: 1,
        },
      ]),
      items: jest.fn(async () => [makeChannel(1)]),
      listFavorites: jest.fn(async () => []),
      listFavoriteKeys: jest.fn(async () => []),
      nowNext: jest.fn(async () => []),
      resolveStream: jest.fn(),
      addSource: jest.fn(),
      addSourceFromLink: jest.fn(),
      removeSource: jest.fn(),
      importSource: jest.fn(),
      seasons: jest.fn(),
      episodes: jest.fn(),
      close: jest.fn(async () => undefined),
    } as unknown as CatalogService;

    await render(
      wrapWithHealth(
        <LiveScreen
          catalog={catalog}
          sources={[DEMO_SOURCE]}
          refreshToken={0}
          defaultLiveMode="channels"
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
        />,
        { idleProbeController },
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('live-cat-chip-1')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('live-cat-chip-1'));
    expect(probeSignal?.aborted).toBe(true);
    expect(idleProbeController.activeCount()).toBe(0);
  });

  it('useLiveEmbeddedPreview reports strictly HTTP(S) origin with zero credentials and skips rtsp/udp (#317)', async () => {
    const channel = makeChannel(1);
    const engineOpts = {
      now: () => 1_000,
      schedule: (fn: () => void, ms: number) => setTimeout(fn, ms),
      cancel: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };

    // 1. Xtream URL with userinfo + path credentials reports origin only
    {
      const engine = createFakePlayerEngine(engineOpts);
      const videoHost: VideoHost = {
        open: () => ({ engine, renderSurface: () => <View /> }),
      };
      const reportStreamOutcome = jest.fn();
      const catalog = {
        resolveStream: jest.fn(async () =>
          ok<StreamRequest>({
            url: ['http://u:p@preview.example.test:8080', 'live', 'demo', 'cred', '7.ts'].join('/'),
            headers: {},
            sourceId: 's1',
            accountKey: 's1',
          }),
        ),
        reportStreamOutcome,
      };
      const hook = await renderHook(() =>
        useLiveEmbeddedPreview({
          enabled: true,
          activeChannel: channel,
          sources: [DEMO_SOURCE],
          catalog,
          videoHost,
        }),
      );
      await waitFor(() => {
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      const loadCmd = engine.commands.find((c) => c.name === 'load');
      await act(async () => {
        engine.emit({ type: 'firstFrame', attempt: loadCmd?.attempt ?? 1, atMs: 120 });
      });
      expect(reportStreamOutcome).toHaveBeenCalledTimes(1);
      expect(reportStreamOutcome).toHaveBeenCalledWith(
        's1',
        'http://preview.example.test:8080',
        true,
      );
      await hook.unmount();
    }

    // 2. Non-HTTP(S) URLs (rtsp:// and udp://) skip reportStreamOutcome
    for (const nonHttpUrl of ['rtsp://preview.example.test:554/live/1', 'udp://239.0.0.1:1234']) {
      const engine = createFakePlayerEngine(engineOpts);
      const videoHost: VideoHost = {
        open: () => ({ engine, renderSurface: () => <View /> }),
      };
      const reportStreamOutcome = jest.fn();
      const catalog = {
        resolveStream: jest.fn(async () =>
          ok<StreamRequest>({
            url: nonHttpUrl,
            headers: {},
            sourceId: 's1',
            accountKey: 's1',
          }),
        ),
        reportStreamOutcome,
      };
      const hook = await renderHook(() =>
        useLiveEmbeddedPreview({
          enabled: true,
          activeChannel: channel,
          sources: [DEMO_SOURCE],
          catalog,
          videoHost,
        }),
      );
      await waitFor(() => {
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      const loadCmd = engine.commands.find((c) => c.name === 'load');
      await act(async () => {
        engine.emit({ type: 'firstFrame', attempt: loadCmd?.attempt ?? 1, atMs: 120 });
      });
      expect(reportStreamOutcome).not.toHaveBeenCalled();
      await hook.unmount();
    }
  });
});

import type { CatalogService, FavoriteRow, ItemRow, ProgrammeRow, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  buildTheme,
  I18nProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { RouteActiveProvider } from '../../shared';
import { LiveScreen, type LiveScreenProps } from '../LiveScreen';
import { formatClockTime } from '../live-model';

const HOUR = 3_600_000;
const BASE_MS = Date.UTC(2026, 10, 21, 18, 0, 0);
const NOW_MS = BASE_MS + 15 * 60_000;

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 800,
};

function makeSources(): SourceRow[] {
  return [
    {
      id: 'src-1',
      kind: 'xtream',
      name: 'Alpha TV',
      createdAt: 1,
      needsImport: false,
      credentialFingerprint: 'fp-alpha',
    },
    {
      id: 'src-2',
      kind: 'xtream',
      name: 'Beta Stream',
      createdAt: 2,
      needsImport: false,
      credentialFingerprint: 'fp-beta',
    },
  ];
}

function makeChannels(): ItemRow[] {
  return [
    {
      id: 1,
      key: 'x:src-1:live:101',
      kind: 'live',
      sourceId: 'src-1',
      providerId: '101',
      name: '[TR] FHD | News One (TR)',
      logo: 'https://logos.example.test/ch-1.png',
      rating: null,
      year: null,
      num: 101,
    },
    {
      id: 2,
      key: 'x:src-2:live:102',
      kind: 'live',
      sourceId: 'src-2',
      providerId: '102',
      name: '4K | Sports Arena',
      logo: 'https://logos.example.test/ch-2.png',
      rating: null,
      year: null,
      num: 102,
    },
  ];
}

function makeMockCatalog(
  channels: readonly ItemRow[],
  favorites: readonly FavoriteRow[] = [],
): CatalogService {
  const [ch0, ch1] = channels;
  if (!ch0 || !ch1) throw new Error('expected at least 2 channels');
  const programmesByKey: Record<string, ProgrammeRow[]> = {
    [ch0.key]: [
      {
        channelKey: ch0.key,
        sourceId: 'src-1',
        guideId: 'g-1',
        start: BASE_MS,
        stop: BASE_MS + HOUR,
        title: 'Evening News',
        subTitle: null,
        description: 'Top headlines',
        episodeNum: null,
        icon: null,
      },
      {
        channelKey: ch0.key,
        sourceId: 'src-1',
        guideId: 'g-1',
        start: BASE_MS + HOUR,
        stop: BASE_MS + 2 * HOUR,
        title: 'Premier League Football',
        subTitle: 'Live Match',
        description: 'Championship sports coverage',
        episodeNum: null,
        icon: null,
      },
    ],
    [ch1.key]: [
      {
        channelKey: ch1.key,
        sourceId: 'src-2',
        guideId: 'g-2',
        start: BASE_MS,
        stop: BASE_MS + 2 * HOUR,
        title: 'Sports Arena Live',
        subTitle: null,
        description: 'Sports highlights',
        episodeNum: null,
        icon: null,
      },
    ],
  };

  return {
    listSources: async () => makeSources(),
    addSource: async () => {
      throw new Error('unused');
    },
    addSourceFromLink: async () => {
      throw new Error('unused');
    },
    removeSource: async () => ok(undefined),
    importSource: async () => {
      throw new Error('unused');
    },
    categories: async (sourceId: string) =>
      sourceId === 'src-1'
        ? [
            {
              id: 'src-1|live|cat-0',
              sourceId: 'src-1',
              kind: 'live',
              name: 'All Live',
              position: 0,
              itemCount: channels.length,
            },
          ]
        : [],
    items: async (_src: string, _kind: string, opts?: { offset?: number; limit?: number }) => {
      const offset = opts?.offset ?? 0;
      const limit = opts?.limit ?? 50;
      return channels.slice(offset, offset + limit);
    },
    series: async () => [],
    episodes: async () => [],
    search: async () => [],
    listFavorites: async () => [...favorites],
    isFavorite: async (_k: string, itemKey: string) => favorites.some((f) => f.itemKey === itemKey),
    toggleFavorite: async () => false,
    listContinueWatching: async () => [],
    getProgress: async () => null,
    getProgressByKeys: async () => ({}),
    saveProgress: async () => undefined,
    clearProgress: async () => undefined,
    nowNext: async () => [],
    epgWindow: async (keys: readonly string[]) => {
      const out: Record<string, ProgrammeRow[]> = {};
      for (const k of keys) out[k] = programmesByKey[k] ?? [];
      return out;
    },
    channelByNumber: async () => null,
    resolveStream: async (key: string) =>
      ok({
        url: `https://stream.example.test/${encodeURIComponent(key)}.ts`,
        headers: {},
      }),
    close: async () => undefined,
  } as unknown as CatalogService;
}

async function renderLive(
  props: Partial<LiveScreenProps> & {
    sources?: SourceRow[];
    channels?: ItemRow[];
    favorites?: FavoriteRow[];
  } = {},
) {
  const channels = props.channels ?? makeChannels();
  const sources = props.sources ?? makeSources();
  const catalog = props.catalog ?? makeMockCatalog(channels, props.favorites);
  const onPlay = props.onPlay ?? jest.fn();
  const view = await render(
    <RouteActiveProvider active>
      <ThemeProvider>
        <ViewportProvider value={DESKTOP_VIEWPORT}>
          <I18nProvider i18n={createAppI18n('en')}>
            <LiveScreen
              catalog={catalog}
              sources={sources}
              refreshToken={0}
              nowMs={NOW_MS}
              onPlay={onPlay}
              onOpenSources={() => undefined}
              {...props}
            />
          </I18nProvider>
        </ViewportProvider>
      </ThemeProvider>
    </RouteActiveProvider>,
  );
  return { onPlay, channels, view };
}

describe('Live TV Settings Wiring, Multi-Source Badges, Two-Step Preview & Clean Titles (#126, #145, #401)', () => {
  it('renders deterministic multi-source color badges in Channels & EPG and hides them when disabled or single-source (#126)', async () => {
    const theme = buildTheme();
    const { view } = await renderLive({ defaultLiveMode: 'channels', showSourceBadges: true });

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-source-badge-0')).toBeTruthy();
      expect(screen.getByTestId('live-channel-source-badge-1')).toBeTruthy();
    });
    const badge0Style = StyleSheet.flatten(
      screen.getByTestId('live-channel-source-badge-0').props.style,
    );
    const badge1Style = StyleSheet.flatten(
      screen.getByTestId('live-channel-source-badge-1').props.style,
    );
    expect(badge0Style.borderColor).toBe(theme.colors.accent);
    expect(badge1Style.borderColor).toBe(theme.colors.successColor);
    expect(screen.getByTestId('live-channel-source-badge-0')).toHaveTextContent('Alpha TV');

    // Switch to EPG and verify source badges appear on EPG channel rows too
    await fireEvent.press(screen.getByTestId('live-mode-epg'));
    await waitFor(() => {
      expect(screen.getByTestId('epg-source-badge-0')).toBeTruthy();
    });
    await view.unmount();

    // Hidden when showSourceBadges === false
    const hidden = await renderLive({ defaultLiveMode: 'channels', showSourceBadges: false });
    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });
    expect(screen.queryByTestId('live-channel-source-badge-0')).toBeNull();
    await hidden.view.unmount();
  });

  it('wires defaultLiveMode, epgTimeSpanHours, epgShowClock, and epgGenreTints (#401)', async () => {
    const theme = buildTheme();
    const { view } = await renderLive({
      defaultLiveMode: 'epg',
      epgTimeSpanHours: 6,
      epgShowClock: true,
      epgGenreTints: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();
      expect(screen.getByTestId('epg-tick-11')).toBeTruthy();
    });
    expect(screen.getByTestId('epg-live-clock')).toHaveTextContent(formatClockTime(NOW_MS));

    // Slot 1 on row 0 is upcoming ("Premier League Football") -> sports genre tint (successColor)
    await waitFor(() => {
      expect(screen.getByTestId('epg-cell-0-1')).toBeTruthy();
    });
    const tintedStyle = StyleSheet.flatten(screen.getByTestId('epg-cell-0-1').props.style);
    expect(tintedStyle.borderLeftColor).toBe(theme.colors.successColor);
    await view.unmount();

    // Verify 2-hour span (4 ticks), hidden clock, and disabled genre tints
    const compact = await renderLive({
      defaultLiveMode: 'epg',
      epgTimeSpanHours: 2,
      epgShowClock: false,
      epgGenreTints: false,
    });
    await waitFor(() => {
      expect(screen.getByTestId('epg-tick-3')).toBeTruthy();
      expect(screen.getByTestId('epg-cell-0-1')).toBeTruthy();
    });
    expect(screen.queryByTestId('epg-tick-4')).toBeNull();
    expect(screen.queryByTestId('epg-live-clock')).toBeNull();
    const plainStyle = StyleSheet.flatten(screen.getByTestId('epg-cell-0-1').props.style);
    expect(plainStyle.borderLeftColor).not.toBe(theme.colors.successColor);
    await compact.view.unmount();
  });

  it('previews channel inline on first OK and releases preview before fullscreen on second OK when liveOkTwoStepPreview is true (#145)', async () => {
    const events: string[] = [];
    let openCount = 0;
    const fakeEngine = createFakePlayerEngine({
      now: () => NOW_MS,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const origRelease = fakeEngine.release.bind(fakeEngine);
    fakeEngine.release = async () => {
      events.push('release');
      await origRelease();
    };
    const videoHost: VideoHost = {
      open: () => {
        openCount += 1;
        return {
          engine: fakeEngine,
          renderSurface: ({ testID }) => <View testID={testID} />,
        };
      },
    };
    const onPlay = jest.fn((_target: PlayTarget) => {
      events.push('onPlay');
    });

    const { view } = await renderLive({
      defaultLiveMode: 'channels',
      liveOkTwoStepPreview: true,
      videoHost,
      onPlay,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toBeTruthy();
    });

    // 1st tap on channel 0 -> previews inline, does NOT launch fullscreen
    await fireEvent.press(screen.getByTestId('live-channel-card-0'));
    await waitFor(() => {
      expect(screen.getByTestId('live-two-step-preview-banner')).toBeTruthy();
    });
    expect(screen.getByTestId('live-two-step-preview-hint')).toHaveTextContent(
      'Press OK again for fullscreen',
    );
    expect(onPlay).not.toHaveBeenCalled();
    expect(openCount).toBe(1);

    // Tap a DIFFERENT channel (channel 1) -> switches preview on the same engine (still openCount === 1!)
    await fireEvent.press(screen.getByTestId('live-channel-card-1'));
    expect(onPlay).not.toHaveBeenCalled();
    expect(openCount).toBe(1);

    // 2nd tap on channel 1 -> stops & releases preview FIRST, then launches fullscreen onPlay
    await fireEvent.press(screen.getByTestId('live-channel-card-1'));
    await waitFor(() => {
      expect(onPlay).toHaveBeenCalledTimes(1);
    });
    expect(events).toEqual(['release', 'onPlay']);
    expect(onPlay.mock.calls[0]?.[0]?.itemKey).toBe('x:src-2:live:102');

    await view.unmount();
  });

  it('non-destructively cleans channel display titles across Channels, EPG, Favorites stage, and Zap Drawer without altering item keys (#145)', async () => {
    const channels = makeChannels();
    const firstChannel = channels[0];
    if (!firstChannel) throw new Error('expected channel');
    const favorites: FavoriteRow[] = [
      {
        profileId: 'default',
        itemKey: firstChannel.key,
        sourceId: 'src-1',
        kind: 'live',
        title: firstChannel.name,
        logo: firstChannel.logo,
        year: null,
        rating: null,
        addedAt: 1,
      },
    ];
    const onPlay = jest.fn();

    const { view } = await renderLive({
      defaultLiveMode: 'channels',
      cleanChannelTitles: true,
      logoBackdropMode: 'off',
      channels,
      favorites,
      onPlay,
    });

    await waitFor(() => {
      expect(screen.getByTestId('live-channel-card-0')).toHaveTextContent(/News One/);
    });
    expect(screen.getByTestId('live-channel-card-0')).not.toHaveTextContent(/\[TR\]/);
    expect(screen.getByTestId('live-channel-card-1')).toHaveTextContent(/Sports Arena/);
    expect(screen.getByTestId('live-channel-card-1')).not.toHaveTextContent(/4K \|/);

    // Original ItemRow is completely untouched
    expect(channels[0]?.name).toBe('[TR] FHD | News One (TR)');

    // Launching playback still uses the original channel key
    await fireEvent.press(screen.getByTestId('live-channel-card-0'));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'x:src-1:live:101' }));

    // Check Favorites stage + Zap Drawer also display cleaned title
    await fireEvent.press(screen.getByTestId('live-mode-favorites'));
    await waitFor(() => {
      expect(screen.getByTestId('live-stage-channel-title')).toHaveTextContent('News One');
    });
    expect(screen.getByTestId('live-zap-row-0')).toHaveTextContent(/News One/);
    expect(screen.getByTestId('live-zap-row-0')).not.toHaveTextContent(/\[TR\]/);

    await view.unmount();
  });
});

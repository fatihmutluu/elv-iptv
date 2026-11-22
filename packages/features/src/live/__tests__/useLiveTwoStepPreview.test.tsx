import type { CatalogService, ItemRow, SourceRow } from '@elv/data';
import { act, renderHook } from '@testing-library/react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import type { LiveMode, LiveTabMemory } from '../live-model';
import { useLiveTwoStepPreview } from '../useLiveTwoStepPreview';

const mockStopAndRelease = jest.fn<Promise<void>, []>();

jest.mock('../useLiveEmbeddedPreview', () => ({
  useLiveEmbeddedPreview: () => ({
    opened: null,
    statusText: '',
    failed: false,
    stopAndRelease: mockStopAndRelease,
  }),
}));

const CHANNEL: ItemRow = {
  id: 1,
  key: 'x:src-1:live:101',
  kind: 'live',
  sourceId: 'src-1',
  providerId: '101',
  name: 'News One',
  logo: null,
  rating: null,
  year: null,
  num: 101,
};

const SOURCES: readonly SourceRow[] = [
  {
    id: 'src-1',
    kind: 'xtream',
    name: 'Primary',
    createdAt: 1,
    needsImport: false,
    credentialFingerprint: 'fp-1',
  },
];

const MOCK_VIDEO_HOST = {} as unknown as VideoHost;
const MOCK_CATALOG = {} as unknown as CatalogService;

function makeLivePort() {
  return {
    tuneChannel: jest.fn(),
    buildPlayTarget: jest.fn(
      (ch: ItemRow): PlayTarget => ({
        itemKey: ch.key,
        sourceId: ch.sourceId,
        title: ch.name,
        kind: 'live',
        logo: ch.logo,
        itemKind: 'live',
      }),
    ),
  };
}

describe('useLiveTwoStepPreview handoff resilience (#145)', () => {
  beforeEach(() => {
    mockStopAndRelease.mockReset();
  });

  it('resets handoffInFlightRef in finally when stopAndRelease rejects so subsequent handoff succeeds', async () => {
    const onPlay = jest.fn();
    const live = makeLivePort();
    const memoryRef: { current: LiveTabMemory } = {
      current: {
        mode: 'channels',
        categoryId: 'cat-1',
        activeChannelKey: null,
        previousChannelKey: null,
        zapDrawerOpen: true,
      },
    };

    const { result, unmount } = await renderHook(() =>
      useLiveTwoStepPreview({
        mode: 'channels',
        liveOkTwoStepPreview: true,
        activeFavoriteChannel: null,
        readySources: SOURCES,
        catalog: MOCK_CATALOG,
        live,
        memoryRef,
        onPlay,
        videoHost: MOCK_VIDEO_HOST,
      }),
    );

    // 1st press selects channel for preview
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
    });
    expect(result.current.previewedChannel?.channel.key).toBe(CHANNEL.key);

    // 2nd press rejects during stopAndRelease -> must NOT invoke onPlay or leave lock stuck
    mockStopAndRelease.mockRejectedValueOnce(new Error('release failed'));
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
      await Promise.resolve();
    });
    expect(onPlay).not.toHaveBeenCalled();

    // 3rd press succeeds -> handoffInFlightRef was recovered cleanly!
    mockStopAndRelease.mockResolvedValueOnce(undefined);
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
      await Promise.resolve();
    });
    expect(onPlay).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('cancels stale onPlay if mode or category changes while stopAndRelease is pending', async () => {
    let resolveRelease!: () => void;
    mockStopAndRelease.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRelease = resolve;
        }),
    );

    const onPlay = jest.fn();
    const live = makeLivePort();
    const memoryRef: { current: LiveTabMemory } = {
      current: {
        mode: 'channels',
        categoryId: 'cat-1',
        activeChannelKey: null,
        previousChannelKey: null,
        zapDrawerOpen: true,
      },
    };

    const { result, rerender, unmount } = await renderHook(
      ({ mode }: { mode: LiveMode }) =>
        useLiveTwoStepPreview({
          mode,
          liveOkTwoStepPreview: true,
          activeFavoriteChannel: null,
          readySources: SOURCES,
          catalog: MOCK_CATALOG,
          live,
          memoryRef,
          onPlay,
          videoHost: MOCK_VIDEO_HOST,
        }),
      { initialProps: { mode: 'channels' as LiveMode } },
    );

    // 1st press previews, 2nd press starts pending stopAndRelease
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
    });
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
    });

    // User switches category while stopAndRelease is still in flight
    memoryRef.current = { ...memoryRef.current, categoryId: 'cat-2' };
    await act(async () => {
      resolveRelease();
      await Promise.resolve();
    });
    expect(onPlay).not.toHaveBeenCalled();

    // Repeat test with mode change during pending stopAndRelease
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
    });
    await act(async () => {
      result.current.handleWatchAndPlay(CHANNEL, 0);
    });
    memoryRef.current = { ...memoryRef.current, mode: 'epg' };
    await rerender({ mode: 'epg' });
    await act(async () => {
      resolveRelease();
      await Promise.resolve();
    });
    expect(onPlay).not.toHaveBeenCalled();

    await unmount();
  });
});

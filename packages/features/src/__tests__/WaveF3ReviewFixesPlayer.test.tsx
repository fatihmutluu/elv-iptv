import type { CatalogService, ItemRow, ProgrammeRow, SourceRow } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useRef } from 'react';
import { Platform, View } from 'react-native';
import { useShellProfileEffects } from '../app-shell-overlays';
import { LiveScreen, PlayerScreen, type PlayTarget, type VideoHost } from '../index';
import type { ProfileContextValue } from '../shared';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_MEDIA_REWIND = 89;

const NOW_MS = new Date(2026, 4, 15, 18, 0, 0, 0).getTime();
const HOUR_MS = 3_600_000;

function createManualClock(startMs = 5_000) {
  let current = startMs;
  let nextId = 1;
  const scheduled = new Map<number, { fn: () => void; dueAt: number }>();
  return {
    now: () => current,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.set(id, { fn, dueAt: current + Math.max(0, ms) });
      return id;
    },
    cancel: (handle: unknown) => {
      scheduled.delete(handle as number);
    },
    advance: (ms: number) => {
      current += ms;
      for (const [id, entry] of [...scheduled.entries()]) {
        if (entry.dueAt <= current) {
          scheduled.delete(id);
          entry.fn();
        }
      }
    },
  };
}

function createManualAndroidKeySource() {
  let listener: ((ev: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(fn) {
      listener = fn;
      return {
        remove() {
          if (listener === fn) listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 0 });
    });
  };
  return { source, sendKey };
}

function wrap(
  node: ReactElement,
  opts?: {
    readonly formFactor?: 'tv' | 'desktop';
    readonly androidSource?: AndroidKeySource;
  },
): ReactElement {
  const formFactor = opts?.formFactor ?? 'desktop';
  const isTv = formFactor === 'tv';
  const inner = (
    <TvRemoteProvider>
      <ThemeProvider>
        <ViewportProvider
          value={{
            width: isTv ? 1920 : 1280,
            height: isTv ? 1080 : 720,
            formFactor,
            inputModality: isTv ? 'tv' : 'pointer',
            orientation: 'landscape',
            safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
        >
          <FormFactorProvider value={formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>{node}</I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </ThemeProvider>
    </TvRemoteProvider>
  );
  return opts?.androidSource !== undefined ? (
    <RemoteKeysProvider android={opts.androidSource}>{inner}</RemoteKeysProvider>
  ) : (
    inner
  );
}

const DEMO_SOURCE: SourceRow = {
  id: 's1',
  kind: 'm3u',
  name: 'Demo IPTV',
  createdAt: 1,
  needsImport: false,
};

const makeChannel = (idx: number, overrides: Partial<ItemRow> = {}): ItemRow => ({
  id: idx,
  key: `m:s1:live:${idx}`,
  kind: 'live',
  sourceId: 's1',
  providerId: String(idx),
  name: `Channel ${idx}`,
  logo: null,
  rating: null,
  year: null,
  num: idx,
  catchupDays: 3,
  ...overrides,
});

function ParentalRelockHarness({
  unlocked,
  catchupTarget,
  catalog,
  onStopPlayback,
}: {
  readonly unlocked: boolean;
  readonly catchupTarget: PlayTarget;
  readonly catalog: CatalogService;
  readonly onStopPlayback: () => void;
}) {
  const targetRef = useRef<PlayTarget | null>(catchupTarget);
  const profile = {
    activeProfileId: 'kids-1',
    parentalUnlocked: unlocked,
    lockParentalNow: jest.fn(),
  } as unknown as ProfileContextValue;
  useShellProfileEffects({
    profile,
    catalog,
    appForeground: true,
    playTargetRef: targetRef,
    onResetTransientMemory: jest.fn(),
    onStopPlayback,
  });
  return null;
}

describe('Wave F3 Review Fixes — Player Connection Safety, Parental Catch-Up Relock & Time-Shift', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stops active stream before tuning new target on PlayerScreen target swap and releases Favorites preview before catch-up (#2)', async () => {
    const manual = createManualClock();
    const events: string[] = [];
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const origStop = engine.stop.bind(engine);
    jest.spyOn(engine, 'stop').mockImplementation((attempt) => {
      events.push('engine.stop');
      origStop(attempt);
    });
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: () => <View testID="surface" />,
      }),
    };
    const catalog = {
      resolveStream: jest.fn(async (key: string) => {
        events.push(`resolve:${key}`);
        return ok({ url: `http://example.invalid/${key}.ts`, headers: {} });
      }),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok({} as never)),
    } as unknown as CatalogService;

    const target1: PlayTarget = {
      itemKey: 'm:s1:live:1',
      sourceId: 's1',
      title: 'Channel 1',
      kind: 'live',
      itemKind: 'live',
    };
    const target2: PlayTarget = {
      itemKey: 'm:s1:live:2',
      sourceId: 's1',
      title: 'Channel 2',
      kind: 'live',
      itemKind: 'live',
    };

    const view = await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={target1}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(events).toContain('resolve:m:s1:live:1'));
    events.length = 0;

    await view.rerender(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={target2}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(events).toContain('resolve:m:s1:live:2'));
    expect(events.indexOf('engine.stop')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('engine.stop')).toBeLessThan(events.indexOf('resolve:m:s1:live:2'));
    await view.unmount();

    // Favorites mode catch-up: preview release MUST complete before onPlay(catchupTarget)
    const favOrder: string[] = [];
    const favEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const origRelease = favEngine.release.bind(favEngine);
    jest.spyOn(favEngine, 'release').mockImplementation(async () => {
      await Promise.resolve();
      favOrder.push('preview.release');
      origRelease();
    });
    const favHost: VideoHost = {
      open: () => ({
        engine: favEngine,
        renderSurface: () => <View testID="fav-surface" />,
      }),
    };
    const favCh = makeChannel(1, { name: 'Fav News', catchupDays: 3 });
    const pastProg: ProgrammeRow = {
      channelKey: favCh.key,
      sourceId: 's1',
      guideId: 'favnews',
      start: NOW_MS - 2 * HOUR_MS,
      stop: NOW_MS - HOUR_MS,
      title: 'Earlier Show',
      subTitle: null,
      description: 'Desc',
      episodeNum: null,
      icon: null,
      genre: 'news',
      flags: 0,
    };
    const favCatalog = {
      listSources: jest.fn(async () => [DEMO_SOURCE]),
      categories: jest.fn(async () => [
        { id: 'cat:1', sourceId: 's1', name: 'News', itemCount: 1 },
      ]),
      items: jest.fn(async () => [favCh]),
      listFavorites: jest.fn(async () => [
        {
          profileId: 'default',
          itemKey: favCh.key,
          sourceId: 's1',
          kind: 'live',
          title: favCh.name,
          logo: null,
          addedAt: 1,
        },
      ]),
      listFavoriteKeys: jest.fn(async () => [favCh.key]),
      itemDetail: jest.fn(async () => favCh),
      nowNext: jest.fn(async () => [{ channelKey: favCh.key, now: pastProg, next: null }]),
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live.ts', headers: {} }),
      ),
    } as unknown as CatalogService;
    const onPlay = jest.fn(() => {
      favOrder.push('onPlay');
    });

    const liveView = await render(
      wrap(
        <LiveScreen
          catalog={favCatalog}
          sources={[DEMO_SOURCE]}
          refreshToken={0}
          memory={{
            mode: 'favorites',
            categoryId: null,
            activeChannelKey: favCh.key,
            previousChannelKey: null,
            zapDrawerOpen: true,
          }}
          videoHost={favHost}
          nowMs={NOW_MS}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('fav-surface')).toBeTruthy());
    await fireEvent(screen.getByTestId('live-zap-row-0'), 'longPress');
    await waitFor(() => expect(screen.getByTestId('live-context-details')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('live-context-details'));
    await waitFor(() => expect(screen.getByTestId('epg-detail-catchup')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('epg-detail-catchup'));

    await waitFor(() => expect(onPlay).toHaveBeenCalledTimes(1));
    expect(favOrder).toEqual(['preview.release', 'onPlay']);
    await liveView.unmount();
  });

  it('stops restricted catch-up playback on parental relock via resolveCatchupStream(title) (#4)', async () => {
    const onStopPlayback = jest.fn();
    const resolveCatchupStream = jest.fn(async () => err(elvError('auth', 'parental-locked')));
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live.ts', headers: {} }),
      ),
      resolveCatchupStream,
    } as unknown as CatalogService;

    const catchupTarget: PlayTarget = {
      itemKey: 'm:s1:live:1',
      sourceId: 's1',
      title: 'Restricted Late Show',
      kind: 'vod',
      catchup: {
        startMs: NOW_MS - 2 * HOUR_MS,
        stopMs: NOW_MS - HOUR_MS,
        programmeTitle: 'Restricted Late Show',
        liveTarget: {
          itemKey: 'm:s1:live:1',
          sourceId: 's1',
          title: 'Channel 1',
          kind: 'live',
        },
      },
    };

    const view = await render(
      <ParentalRelockHarness
        unlocked
        catchupTarget={catchupTarget}
        catalog={catalog}
        onStopPlayback={onStopPlayback}
      />,
    );
    await view.rerender(
      <ParentalRelockHarness
        unlocked={false}
        catchupTarget={catchupTarget}
        catalog={catalog}
        onStopPlayback={onStopPlayback}
      />,
    );
    await waitFor(() => expect(onStopPlayback).toHaveBeenCalledTimes(1));
    expect(resolveCatchupStream).toHaveBeenCalledWith('m:s1:live:1', {
      startMs: NOW_MS - 2 * HOUR_MS,
      stopMs: NOW_MS - HOUR_MS,
      title: 'Restricted Late Show',
    });
    await view.unmount();
  });

  it('handles live time-shift desktop shortcuts, TV scrubber focus, unavailable OSD reveal, and Back-to-live speed reset (#8, #9)', async () => {
    const manual = createManualClock(5_000);
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const seekSpy = jest.spyOn(engine, 'seek');
    const pauseSpy = jest.spyOn(engine, 'pause');
    const videoHost: VideoHost = {
      open: () => ({
        engine,
        renderSurface: () => <View testID="player-surface" />,
      }),
    };
    const catalog = {
      resolveStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/live.ts', headers: {} }),
      ),
      resolveCatchupStream: jest.fn(async () =>
        ok({ url: 'http://example.invalid/timeshift.ts', headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok({} as never)),
    } as unknown as CatalogService;

    // 1. Desktop web shortcuts on time-shifted live stream
    const origOs = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const listeners = new Map<string, (e: unknown) => void>();
    const origWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      document: { activeElement: null },
      addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    try {
      const liveTarget: PlayTarget = {
        itemKey: 'm:s1:live:1',
        sourceId: 's1',
        title: 'Live TS',
        kind: 'live',
      };
      const deskView = await render(
        wrap(
          <PlayerScreen
            catalog={catalog}
            videoHost={videoHost}
            target={liveTarget}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={jest.fn()}
          />,
          { formFactor: 'desktop' },
        ),
      );
      await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
      const deskLoad = engine.commands.find((c) => c.name === 'load');
      const deskAttempt =
        deskLoad && 'attempt' in deskLoad && typeof deskLoad.attempt === 'number'
          ? deskLoad.attempt
          : 1;
      await act(async () => {
        engine.emit({ type: 'state', state: 'playing', attempt: deskAttempt });
        engine.emit({
          type: 'clock',
          attempt: deskAttempt,
          anchor: {
            positionMs: 120_000,
            atMs: 5_000,
            rate: 1,
            liveSeekableStartMs: 0,
            liveEdgeMs: 180_000,
            timeShiftSupported: true,
          },
        });
      });
      await waitFor(() => expect(screen.getByTestId('player-live-timeshift-bar')).toBeTruthy());

      const keydown = listeners.get('keydown');
      await act(async () => {
        keydown?.({
          key: ' ',
          preventDefault: jest.fn(),
          stopPropagation: jest.fn(),
          stopImmediatePropagation: jest.fn(),
        });
        keydown?.({ key: 'j', preventDefault: jest.fn() });
        keydown?.({ key: 'ArrowRight', preventDefault: jest.fn() });
      });
      expect(pauseSpy).toHaveBeenCalled();
      expect(seekSpy).toHaveBeenCalled();
      await deskView.unmount();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
      (globalThis as { window?: unknown }).window = origWindow;
    }

    // 2. TV mode: unsupported live rewind reveals OSD + unavailable hint; supported live focuses LiveTimeShiftBar on D-pad Up
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const remote = createManualAndroidKeySource();
    const tvEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const tvHost: VideoHost = {
      open: () => ({
        engine: tvEngine,
        renderSurface: () => <View testID="player-surface" />,
      }),
    };
    const tvLiveTarget: PlayTarget = {
      itemKey: 'm:s1:live:2',
      sourceId: 's1',
      title: 'TV Live',
      kind: 'live',
    };
    const tvView = await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={tvHost}
          target={tvLiveTarget}
          initialOsdHidden
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
        { formFactor: 'tv', androidSource: remote.source },
      ),
    );
    await waitFor(() => expect(tvEngine.commands.some((c) => c.name === 'load')).toBe(true));
    const tvLoad = tvEngine.commands.find((c) => c.name === 'load');
    const tvAttempt =
      tvLoad && 'attempt' in tvLoad && typeof tvLoad.attempt === 'number' ? tvLoad.attempt : 1;
    await act(async () => {
      tvEngine.emit({ type: 'state', state: 'playing', attempt: tvAttempt });
    });
    await remote.sendKey(KEYCODE_MEDIA_REWIND);
    await waitFor(() => expect(screen.getByTestId('player-timeshift-unavailable')).toBeTruthy());

    await act(async () => {
      tvEngine.emit({
        type: 'clock',
        attempt: tvAttempt,
        anchor: {
          positionMs: 100_000,
          atMs: 5_000,
          rate: 1,
          liveSeekableStartMs: 0,
          liveEdgeMs: 180_000,
          timeShiftSupported: true,
        },
      });
    });
    await waitFor(() => expect(screen.getByTestId('player-live-timeshift-bar')).toBeTruthy());
    await remote.sendKey(KEYCODE_DPAD_RIGHT); // enters TV OSD bar
    await remote.sendKey(KEYCODE_DPAD_UP); // focuses LiveTimeShiftBar
    await waitFor(() =>
      expect(screen.getByTestId('player-live-timeshift-focus-ring')).toBeTruthy(),
    );
    await tvView.unmount();

    // 3. Catch-Up -> setSpeed(2) -> "Back to live" resets speed back to 1x (#9)
    const cuEngine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const cuSetSpeedSpy = jest.fn();
    cuEngine.setSpeed = cuSetSpeedSpy;
    const cuHost: VideoHost = {
      open: () => ({
        engine: cuEngine,
        renderSurface: () => <View testID="player-surface" />,
      }),
    };
    const catchupTarget: PlayTarget = {
      itemKey: 'm:s1:live:1',
      sourceId: 's1',
      title: 'Past Show',
      kind: 'vod',
      catchup: {
        startMs: NOW_MS - 2 * HOUR_MS,
        stopMs: NOW_MS - HOUR_MS,
        programmeTitle: 'Past Show',
        liveTarget: {
          itemKey: 'm:s1:live:1',
          sourceId: 's1',
          title: 'Channel 1',
          kind: 'live',
        },
      },
    };
    const cuView = await render(
      wrap(
        <PlayerScreen
          catalog={catalog}
          videoHost={cuHost}
          target={catchupTarget}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByTestId('player-back-to-live')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('player-speed-button'));
    await waitFor(() => expect(screen.getByTestId('player-settings-speed-2')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('player-settings-speed-2'));
    expect(cuSetSpeedSpy).toHaveBeenCalledWith(expect.anything(), 2);

    // Advance past PlaybackService speed coalescing window, then switch Back to live.
    await act(async () => {
      manual.advance(500);
    });
    await fireEvent.press(screen.getByTestId('player-back-to-live'));
    await waitFor(() => expect(cuSetSpeedSpy).toHaveBeenCalledWith(expect.anything(), 1));
    expect(screen.queryByTestId('player-settings-speed-2')).toBeNull();
    await cuView.unmount();
  });
});

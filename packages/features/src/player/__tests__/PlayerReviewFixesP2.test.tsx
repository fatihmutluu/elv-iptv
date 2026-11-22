import type { NowNextEntry } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import type { LiveChannelPlaylist, PlayableEntry, PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { PROGRESS_OSD_AUTO_HIDE_MS } from '../player-overlay-model';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEY_BACK = 4;
const KEY_DOWN = 20;
const KEY_LEFT = 21;
const KEY_SELECT = 23;
const KEY_FAST_FORWARD = 90;
const KEY_INFO = 165;
const KEY_GUIDE = 172;

const EPOCH_START = 1_760_000_000_000;
const EPOCH_NOW = 1_760_000_050_000;
const EPOCH_STOP = 1_760_000_100_000;

const TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 }],
  subtitles: [{ id: 's:1', language: 'eng', label: 'English', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

function makeChannels(count: number): readonly PlayableEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    itemKey: `ch:${i}`,
    sourceId: 's1',
    title: `${i + 1}. Channel ${i + 1}`,
    kind: 'live' as const,
  }));
}

function makePlaylist(items: readonly PlayableEntry[], initialIndex = 0): LiveChannelPlaylist {
  let idx = initialIndex;
  return {
    count: items.length,
    get currentIndex() {
      return idx;
    },
    getAt: async (i) => items[i],
    onChangeIndex: (next) => {
      idx = next;
    },
  };
}

function makeEpochNowNext(channelKey: string): NowNextEntry {
  return {
    channelKey,
    now: {
      channelKey,
      sourceId: 's1',
      guideId: channelKey,
      title: 'Epoch Broadcast',
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
      start: EPOCH_START,
      stop: EPOCH_STOP,
    },
    next: null,
  };
}

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:s1:ep:1',
  sourceId: 's1',
  title: 'Series — Ep 1',
  kind: 'vod',
};

async function mountPlayer(opts: {
  formFactor: FormFactor;
  os: 'web' | 'android';
  target: PlayTarget;
  initialOsdHidden?: boolean;
  initialVolume?: number;
  wallClock?: () => number;
  autoSubtitlesOnSkipBack?: boolean;
  autoPlayNextEpisode?: boolean;
  nowNext?: jest.Mock;
}) {
  jest.replaceProperty(Platform, 'OS', opts.os as typeof Platform.OS);
  if (opts.formFactor === 'tv') {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  }
  const keys = createFakeAndroidKeys();
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const setVolume = jest.fn();
  const setSpeed = jest.fn();
  engine.setSpeed = setSpeed;
  const selectSubtitleSpy = jest.spyOn(engine, 'selectSubtitleTrack');
  const onToggleAutoPlayNextEpisode = jest.fn();

  const opened: OpenVideoEngine = {
    engine,
    renderSurface: ({ testID }) => <View testID={testID ?? 'surface'} />,
    setVolume,
  };
  const catalog: PlayerScreenProps['catalog'] = {
    resolveStream: jest.fn(async (key: string) =>
      ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
    ),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async (input) =>
      ok({
        profileId: 'default',
        sourceId: input.sourceId,
        itemKey: input.itemKey,
        kind: input.kind,
        title: input.title,
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: input.positionMs,
        durationMs: input.durationMs,
        watched: false,
        updatedAt: 0,
      }),
    ),
    ...(opts.nowNext !== undefined ? { nowNext: opts.nowNext } : {}),
  };

  const buildTree = (target: PlayTarget) => (
    <ThemeProvider preset="obsidianCrimson">
      <RemoteKeysProvider android={opts.formFactor === 'tv' ? keys.source : null}>
        <TvRemoteProvider>
          <ViewportProvider
            value={{
              width: opts.formFactor === 'phone' ? 393 : 1280,
              height: opts.formFactor === 'phone' ? 852 : 720,
              formFactor: opts.formFactor,
              orientation: opts.formFactor === 'phone' ? 'portrait' : 'landscape',
            }}
          >
            <FormFactorProvider value={opts.formFactor}>
              <I18nProvider i18n={createAppI18n('en')}>
                <PlayerScreen
                  catalog={catalog}
                  videoHost={{ open: () => opened }}
                  target={target}
                  clock={{ now: manual.now }}
                  {...(opts.wallClock !== undefined ? { wallClock: opts.wallClock } : {})}
                  timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                  {...(opts.initialOsdHidden !== undefined
                    ? { initialOsdHidden: opts.initialOsdHidden }
                    : {})}
                  {...(opts.initialVolume !== undefined
                    ? { initialVolume: opts.initialVolume }
                    : {})}
                  {...(opts.autoSubtitlesOnSkipBack !== undefined
                    ? { autoSubtitlesOnSkipBack: opts.autoSubtitlesOnSkipBack }
                    : {})}
                  {...(opts.autoPlayNextEpisode !== undefined
                    ? { autoPlayNextEpisode: opts.autoPlayNextEpisode }
                    : {})}
                  onToggleAutoPlayNextEpisode={onToggleAutoPlayNextEpisode}
                  onExit={jest.fn()}
                />
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </TvRemoteProvider>
      </RemoteKeysProvider>
    </ThemeProvider>
  );

  const view = await render(buildTree(opts.target));
  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;

  return {
    view,
    keys,
    manual,
    engine,
    attempt,
    setVolume,
    setSpeed,
    selectSubtitleSpy,
    onToggleAutoPlayNextEpisode,
    rerenderTarget: (next: PlayTarget) => view.rerender(buildTree(next)),
  };
}

describe('Wave P2 review fixes (P0/P1/P2 #699)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('P0 #1 & P0 #2: uses wallClock (Unix epoch) instead of monotonic clock for EPG queries/progress and applies initialVolume on engine open', async () => {
    const nowNext = jest.fn(async (keys: readonly string[]) => [makeEpochNowNext(keys[0] ?? '')]);
    const items = makeChannels(3);
    const first = items[0] as PlayableEntry;
    const p = await mountPlayer({
      formFactor: 'desktop',
      os: 'web',
      target: { ...first, playlist: makePlaylist(items, 0) },
      initialVolume: 30,
      wallClock: () => EPOCH_NOW,
      nowNext,
    });

    // P0 #2: saved initialVolume=30 applied immediately on engine open
    expect(p.setVolume).toHaveBeenCalledWith(30);

    // P0 #1: EPG queried with real epoch wallClock (NOT monotonic 0..5000)
    await waitFor(() => {
      expect(nowNext).toHaveBeenCalledWith(['ch:0'], EPOCH_NOW);
    });

    // Open Info sheet via Player Settings -> 50% progress derived from wallClock
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-info-button'));
    expect(
      StyleSheet.flatten(screen.getByTestId('player-info-progress-fill').props.style)?.width,
    ).toBe('50%');

    // Open Channel drawer -> schedule fetch also uses wallClock
    nowNext.mockClear();
    await fireEvent.press(screen.getByTestId('player-channel-list-button'));
    await waitFor(() => {
      expect(nowNext).toHaveBeenCalledWith(['ch:0'], EPOCH_NOW);
    });

    await p.view.unmount();
  });

  it('P0 #3 & P1 #6: TV guide/info keys open ChannelDrawer/InfoSheet, D-pad down repeats scroll into view, and Select zaps cleanly', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const scrollSpy = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(jest.fn());
    const items = makeChannels(15);
    const first = items[0] as PlayableEntry;
    const p = await mountPlayer({
      formFactor: 'tv',
      os: 'android',
      target: { ...first, playlist: makePlaylist(items, 0) },
    });

    await act(async () => {
      p.manual.advance(350);
    });

    // P1 #6: KEY_INFO toggles PlayerInfoSheet cleanly
    await act(async () => p.keys.tap(KEY_INFO));
    expect(screen.getByTestId('player-info-panel')).toBeTruthy();
    await act(async () => p.keys.tap(KEY_INFO));
    expect(screen.queryByTestId('player-info-panel')).toBeNull();

    // P1 #6 + P0 #3: KEY_GUIDE opens PlayerChannelDrawer; Back closes it; re-open & Down scrolls + Select zaps
    await act(async () => p.keys.tap(KEY_GUIDE));
    expect(screen.getByTestId('player-channel-drawer-overlay')).toBeTruthy();
    await act(async () => p.keys.tap(KEY_BACK));
    expect(screen.queryByTestId('player-channel-drawer-overlay')).toBeNull();
    await act(async () => p.keys.tap(KEY_GUIDE));
    expect(screen.getByTestId('player-channel-drawer-overlay')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('player-channel-row-0')).toBeTruthy();
    });

    // Step down 6 times (well past row 2) -> scrollTo called with positive y
    for (let i = 0; i < 6; i++) {
      await act(async () => p.keys.tap(KEY_DOWN));
    }
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ y: expect.any(Number), animated: false }),
    );
    expect(
      scrollSpy.mock.calls.some(
        ([arg]) => typeof arg === 'object' && arg !== null && ((arg as { y?: number }).y ?? 0) > 0,
      ),
    ).toBe(true);

    // Select tunes Channel 7 (index 6) and closes drawer
    await act(async () => p.keys.tap(KEY_SELECT));
    await waitFor(() => {
      expect(screen.getByTestId('osd-title')).toHaveTextContent('7. Channel 7');
    });
    expect(screen.queryByTestId('player-channel-drawer-overlay')).toBeNull();

    await p.view.unmount();
  });

  it('P1 #5 & P1 #8: TV FastForward from hidden enters 2s progress peek; ArrowLeft scrub commit & touch swipe rewind trigger autoSubtitlesOnSkipBack', async () => {
    const tv = await mountPlayer({
      formFactor: 'tv',
      os: 'android',
      target: VOD_TARGET,
      initialOsdHidden: true,
      autoSubtitlesOnSkipBack: true,
    });
    await act(async () => {
      tv.manual.advance(350);
      tv.engine.emit({
        attempt: tv.attempt,
        type: 'clock',
        anchor: { positionMs: 50_000, atMs: tv.manual.now(), rate: 1, durationMs: 120_000 },
      });
      tv.engine.emit({ attempt: tv.attempt, type: 'tracks', tracks: TRACKS });
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // P1 #5: FastForward while hidden enters lightweight 'progress' peek ONLY and hides after 2s
    await act(async () => tv.keys.tap(KEY_FAST_FORWARD));
    expect(screen.getByTestId('player-osd-progress-peek')).toBeTruthy();
    expect(screen.queryByTestId('player-osd-top')).toBeNull();
    expect(screen.queryByTestId('player-center-transport')).toBeNull();
    await act(async () => {
      tv.manual.advance(PROGRESS_OSD_AUTO_HIDE_MS);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // P1 #8 (part 1): Wake OSD -> ArrowLeft scrub commit activates skip-back subtitles
    await act(async () => tv.keys.tap(KEY_SELECT));
    await act(async () => tv.keys.tap(KEY_LEFT));
    expect(tv.selectSubtitleSpy).toHaveBeenCalledWith(expect.any(Number), 's:1');
    await tv.view.unmount();

    // P1 #8 (part 2): Mobile horizontal touch swipe rewind also activates skip-back subtitles
    const mobile = await mountPlayer({
      formFactor: 'phone',
      os: 'android',
      target: VOD_TARGET,
      autoSubtitlesOnSkipBack: true,
    });
    await act(async () => {
      mobile.manual.advance(350);
      mobile.engine.emit({
        attempt: mobile.attempt,
        type: 'clock',
        anchor: { positionMs: 60_000, atMs: mobile.manual.now(), rate: 1, durationMs: 120_000 },
      });
      mobile.engine.emit({ attempt: mobile.attempt, type: 'tracks', tracks: TRACKS });
    });
    const gestures = screen.getByTestId('player-touch-gestures');
    await fireEvent(gestures, 'layout', { nativeEvent: { layout: { width: 400, height: 800 } } });
    await fireEvent(gestures, 'responderGrant', {
      nativeEvent: { locationX: 250, locationY: 400 },
    });
    await fireEvent(gestures, 'responderMove', {
      nativeEvent: { locationX: 150, locationY: 400 },
    });
    await fireEvent(gestures, 'responderRelease', {
      nativeEvent: { locationX: 150, locationY: 400 },
    });
    expect(mobile.selectSubtitleSpy).toHaveBeenCalledWith(expect.any(Number), 's:1');
    await mobile.view.unmount();
  });

  it('P1 #9 & P1 #10 & P2: keeps brightness dim overlay mounted across Lock/Settings, wires autoPlayNextEpisode toggle, and resets speed on item change', async () => {
    const mobile = await mountPlayer({
      formFactor: 'phone',
      os: 'android',
      target: VOD_TARGET,
      autoPlayNextEpisode: true,
    });
    await act(async () => {
      mobile.manual.advance(350);
      mobile.engine.emit({
        attempt: mobile.attempt,
        type: 'clock',
        anchor: { positionMs: 20_000, atMs: mobile.manual.now(), rate: 1, durationMs: 120_000 },
      });
      mobile.engine.emit({ attempt: mobile.attempt, type: 'tracks', tracks: TRACKS });
    });

    // Swipe down on left half to dim screen
    const gestures = screen.getByTestId('player-touch-gestures');
    await fireEvent(gestures, 'layout', { nativeEvent: { layout: { width: 393, height: 852 } } });
    await fireEvent(gestures, 'responderGrant', {
      nativeEvent: { locationX: 80, locationY: 200 },
    });
    await fireEvent(gestures, 'responderMove', {
      nativeEvent: { locationX: 80, locationY: 500 },
    });
    await fireEvent(gestures, 'responderRelease', {
      nativeEvent: { locationX: 80, locationY: 500 },
    });
    expect(screen.getByTestId('player-brightness-dim-overlay')).toBeTruthy();

    // P1 #9: Lock controls -> dim overlay MUST stay mounted!
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(screen.getByTestId('player-locked-overlay')).toBeTruthy();
    expect(screen.getByTestId('player-brightness-dim-overlay')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('player-unlock-button'));

    // P1 #9 + P1 #10: Open Settings -> dim overlay STILL stays mounted, and autoPlayNextEpisode toggle works!
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(
      screen.getByTestId('player-brightness-dim-overlay', { includeHiddenElements: true }),
    ).toBeTruthy();
    const autoPlayToggle = screen.getByTestId('player-auto-play-next-toggle');
    expect(autoPlayToggle).toHaveTextContent(/Auto-play next episode/);
    await fireEvent.press(autoPlayToggle);
    expect(mobile.onToggleAutoPlayNextEpisode).toHaveBeenCalledTimes(1);

    // P2: Set speed 1.5x, then switch to another item -> speed UI & controls reset to 1x
    await fireEvent.press(screen.getByTestId('player-settings-row-speed'));
    await fireEvent.press(screen.getByTestId('player-settings-speed-1.5'));
    expect(mobile.setSpeed).toHaveBeenLastCalledWith(expect.any(Number), 1.5);
    await mobile.rerenderTarget({ ...VOD_TARGET, itemKey: 'x:s1:ep:2', title: 'Series — Ep 2' });
    await act(async () => {
      mobile.manual.advance(350);
    });
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.getByTestId('player-settings-row-speed')).toHaveTextContent(/1×/);

    await mobile.view.unmount();
  });
});

import type { SaveProgressInput, WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  THEME_PRESETS,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEY_UP = 19;
const KEY_DOWN = 20;
const KEY_RIGHT = 22;
const KEY_SELECT = 23;
const KEY_BACK = 4;

const TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
    { id: 'a:2', language: 'eng', label: 'English', codec: 'ac3', channels: 6 },
  ],
  subtitles: [
    { id: 's:1', language: 'tur', codec: 'subrip' },
    { id: 's:2', language: 'eng', codec: 'subrip' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const EP2: PlayableEntry = {
  itemKey: 'x:s1:ep:2',
  sourceId: 's1',
  title: 'Starlight — E2',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:1',
  season: 1,
  episode: 2,
  subtitle: 'S1 E2 · Drift',
};

const EP3: PlayableEntry = {
  itemKey: 'x:s1:ep:3',
  sourceId: 's1',
  title: 'Starlight — E3',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:1',
  season: 1,
  episode: 3,
  subtitle: 'S1 E3 · Signal',
};

const EP1_TARGET: PlayTarget = {
  itemKey: 'x:s1:ep:1',
  sourceId: 's1',
  title: 'Starlight — E1',
  kind: 'vod',
  itemKind: 'episode',
  seriesKey: 'x:s1:series:1',
  season: 1,
  episode: 1,
  subtitle: 'S1 E1 · Pilot',
  nextEpisodes: [EP2, EP3],
};

function makeSavedRow(input: SaveProgressInput): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: input.sourceId,
    itemKey: input.itemKey,
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle ?? null,
    logo: input.logo ?? null,
    seriesKey: input.seriesKey ?? null,
    season: input.season ?? null,
    episode: input.episode ?? null,
    positionMs: input.positionMs,
    durationMs: input.durationMs,
    watched: input.watched ?? false,
    updatedAt: 1_700_000_000_000,
  };
}

function flatStyle(testID: string, includeHiddenElements = false) {
  return StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements }).props.style);
}

describe('PlayerScreen Cinema Quietude OSD, 2-level Settings, Touch Lock, Next Episode & AAA', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('drives 2-level Settings menu (Subtitles, Audio, Stats HUD) backed by live PlaybackService', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
      ),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={EP1_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 15_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    });

    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();

    // Open Settings -> closes any open track picker and shows root rows
    await fireEvent.press(screen.getByTestId('player-tracks-button'));
    expect(screen.getByTestId('player-tracks-panel')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.queryByTestId('player-tracks-panel')).toBeNull();
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();

    // Level 2: Subtitles -> select s:1 -> back to root
    await fireEvent.press(screen.getByTestId('player-settings-row-subtitles'));
    await fireEvent.press(screen.getByTestId('player-settings-sub-s:1'));
    expect(engine.commands.filter((c) => c.name === 'selectSubtitleTrack').at(-1)?.trackId).toBe(
      's:1',
    );
    await fireEvent.press(screen.getByTestId('player-settings-back'));
    expect(screen.getByTestId('player-settings-row-audio')).toBeTruthy();

    // Level 2: Audio -> select a:2 -> back to root
    await fireEvent.press(screen.getByTestId('player-settings-row-audio'));
    await fireEvent.press(screen.getByTestId('player-settings-audio-a:2'));
    expect(engine.commands.filter((c) => c.name === 'selectAudioTrack').at(-1)?.trackId).toBe(
      'a:2',
    );
    await fireEvent.press(screen.getByTestId('player-settings-back'));

    // Toggle Stats HUD -> live telemetry renders
    await fireEvent.press(screen.getByTestId('player-stats-toggle'));
    const hud = screen.getByTestId('player-stats-hud');
    expect(hud).toHaveTextContent(/Playing · 0:15 \/ 2:00/);
    expect(hud).toHaveTextContent(/AAC 2\.0 Turkish/);

    // Toggle Stats HUD off
    await fireEvent.press(screen.getByTestId('player-stats-toggle'));
    expect(screen.queryByTestId('player-stats-hud')).toBeNull();

    await view.unmount();
  });

  it('enforces touch-only Mobile Touch Lock on phone/tablet, Portrait dimming, auto-unlock on retune, and hides lock on tv/desktop', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
      ),
    };
    const videoHost = { open: () => ({ engine, renderSurface: () => <View /> }) };

    const wrapMobile = (formFactor: FormFactor, target: PlayTarget) => (
      <ThemeProvider preset="obsidianCrimson">
        <ViewportProvider value={{ formFactor, orientation: 'portrait', width: 390, height: 844 }}>
          <FormFactorProvider value={formFactor}>
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={videoHost}
                target={target}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ViewportProvider>
      </ThemeProvider>
    );

    const phoneView = await render(wrapMobile('phone', EP1_TARGET));
    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    });

    // Portrait: Settings dims VodProgressBar; top-right utility buttons stay compact
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(flatStyle('player-progress-row', true)?.opacity).toBe(0.2);

    // Lock hides OSD + Settings and shows centered Unlock button >= 44px
    await fireEvent.press(
      screen.getByTestId('player-lock-button', { includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('player-osd')).toBeNull();
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(screen.getByTestId('player-locked-overlay')).toBeTruthy();
    expect(flatStyle('player-unlock-button')?.minHeight).toBeGreaterThanOrEqual(44);

    // Unlock restores OSD
    await fireEvent.press(screen.getByTestId('player-unlock-button'));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(screen.queryByTestId('player-locked-overlay')).toBeNull();

    // Auto-unlocks on itemKey retune
    await fireEvent.press(screen.getByTestId('player-lock-button'));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await phoneView.rerender(wrapMobile('phone', { ...EP2, nextEpisodes: [EP3] }));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(screen.queryByTestId('player-locked-overlay')).toBeNull();
    await phoneView.unmount();

    // Tablet also gets lock button; tv and desktop MUST NOT render lock button
    for (const ff of ['tablet', 'tv', 'desktop'] as const) {
      const ffEngine = createFakePlayerEngine({
        now: manual.now,
        schedule: manual.schedule,
        cancel: manual.cancel,
      });
      const v = await render(
        <ThemeProvider preset="obsidianCrimson">
          <FormFactorProvider value={ff}>
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={catalog}
                videoHost={{ open: () => ({ engine: ffEngine, renderSurface: () => <View /> }) }}
                target={EP1_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ThemeProvider>,
      );
      if (ff === 'tablet') {
        expect(screen.getByTestId('player-lock-button')).toBeTruthy();
      } else {
        expect(screen.queryByTestId('player-lock-button')).toBeNull();
      }
      await v.unmount();
    }
  });

  it('handles single-connection Next Episode (#353): threshold, dismiss, flush -> stop -> load(0), and E2 -> E3 chaining', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const order: string[] = [];
    const origStop = engine.stop.bind(engine);
    jest.spyOn(engine, 'stop').mockImplementation((attempt) => {
      order.push('stop');
      origStop(attempt);
    });
    const origLoad = engine.load.bind(engine);
    jest.spyOn(engine, 'load').mockImplementation((cmd) => {
      order.push(`load:${cmd.url}:${String(cmd.startMs ?? 'none')}`);
      origLoad(cmd);
    });

    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async (input: SaveProgressInput) => {
        order.push(`save:${input.itemKey}:${input.positionMs}`);
        return ok(makeSavedRow(input));
      }),
    };
    const onTargetChange = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={EP1_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onTargetChange={onTargetChange}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const ep1Attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;

    // 40% progress -> hidden
    await act(async () => {
      engine.emit({
        attempt: ep1Attempt,
        type: 'clock',
        anchor: { positionMs: 40_000, atMs: manual.now(), rate: 1, durationMs: 100_000 },
      });
    });
    expect(screen.queryByTestId('player-next-episode-banner')).toBeNull();

    // 92% progress -> visible
    await act(async () => {
      engine.emit({
        attempt: ep1Attempt,
        type: 'clock',
        anchor: { positionMs: 92_000, atMs: manual.now(), rate: 1, durationMs: 100_000 },
      });
    });
    expect(screen.getByTestId('player-next-episode-banner')).toBeTruthy();
    expect(screen.getByTestId('player-next-episode')).toHaveTextContent('Next: S1 E2 · Drift');

    // Pressing Next Episode flushes progress, calls stop() BEFORE load(E2, startMs: 0), maxConcurrentMedias === 1
    order.length = 0;
    await fireEvent.press(screen.getByTestId('player-next-episode'));

    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('x:s1:ep:2');
      expect(order.some((e) => e.startsWith('load:http://sim.example.test/x:s1:ep:2.mp4'))).toBe(
        true,
      );
    });

    const saveIdx = order.findIndex((e) => e.startsWith('save:x:s1:ep:1:'));
    const stopIdx = order.indexOf('stop');
    const loadE2Idx = order.indexOf('load:http://sim.example.test/x:s1:ep:2.mp4:0');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(saveIdx);
    expect(loadE2Idx).toBeGreaterThan(stopIdx);
    expect(engine.maxConcurrentMedias()).toBe(1);
    expect(onTargetChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:ep:2',
        startPositionMs: 0,
        nextEpisodes: [EP3],
      }),
    );
    expect(screen.getByTestId('osd-title')).toHaveTextContent('Starlight — E2');

    // E2 ends -> chains cleanly to E3; dismissing hides banner for remainder of E2
    await act(async () => {
      manual.advance(350);
    });
    const ep2Attempt = engine.commands.filter((c) => c.name === 'load').at(-1)?.attempt ?? 2;
    await act(async () => {
      engine.emit({ attempt: ep2Attempt, type: 'state', state: 'ended' });
    });
    expect(screen.getByTestId('player-next-episode')).toHaveTextContent('Next: S1 E3 · Signal');

    await fireEvent.press(screen.getByTestId('player-next-episode-dismiss'));
    expect(screen.queryByTestId('player-next-episode-banner')).toBeNull();

    await view.unmount();
  });

  it('renders LIVE badge and switches cleanly back to previousChannel via button and desktop P shortcut with stop() before load()', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const order: string[] = [];
    const origStop = engine.stop.bind(engine);
    jest.spyOn(engine, 'stop').mockImplementation((attempt) => {
      order.push('stop');
      origStop(attempt);
    });
    const origLoad = engine.load.bind(engine);
    jest.spyOn(engine, 'load').mockImplementation((cmd) => {
      order.push(`load:${cmd.url}`);
      origLoad(cmd);
    });

    const ch1: PlayableEntry = {
      itemKey: 'ch:1',
      sourceId: 's1',
      title: '1. Studio News',
      kind: 'live',
    };
    const ch2: PlayableEntry = {
      itemKey: 'ch:2',
      sourceId: 's1',
      title: '2. Sports One',
      kind: 'live',
    };
    const onTargetChange = jest.fn();
    const catalog = {
      resolveStream: jest.fn(async (k: string) =>
        ok({ url: `http://sim.example.test/${k}.ts`, headers: {} }),
      ),
    };

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={{ ...ch2, previousChannel: ch1 }}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onTargetChange={onTargetChange}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    expect(screen.getByTestId('player-live-badge')).toHaveTextContent('LIVE');
    expect(screen.getByTestId('player-prev-channel')).toBeTruthy();

    order.length = 0;
    await fireEvent.press(screen.getByTestId('player-prev-channel'));

    await waitFor(() => {
      expect(order).toContain('load:http://sim.example.test/ch:1.ts');
    });
    expect(order.indexOf('stop')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('load:http://sim.example.test/ch:1.ts')).toBeGreaterThan(
      order.indexOf('stop'),
    );
    expect(engine.maxConcurrentMedias()).toBe(1);
    expect(screen.getByTestId('osd-title')).toHaveTextContent('1. Studio News');
    expect(onTargetChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        itemKey: 'ch:1',
        previousChannel: expect.objectContaining({ itemKey: 'ch:2' }),
      }),
    );

    // Desktop 'p' key jumps back to ch:2
    order.length = 0;
    const rootOnKeyDown = screen.getByTestId('player-screen').props.onKeyDown as
      | ((e: { key: string; preventDefault?: () => void }) => void)
      | undefined;
    expect(rootOnKeyDown).toBeDefined();
    await act(async () => {
      rootOnKeyDown?.({ key: 'p', preventDefault: jest.fn() });
    });
    await waitFor(() => {
      expect(order).toContain('load:http://sim.example.test/ch:2.ts');
    });
    expect(screen.getByTestId('osd-title')).toHaveTextContent('2. Sports One');

    await view.unmount();
  });

  it('applies WCAG AAA High Contrast tokens and navigates 10-ft TV D-pad OSD -> settings -> subview -> Back -> close', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    const keys = createFakeAndroidKeys();
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onExit = jest.fn();

    const view = await render(
      <ThemeProvider preset="highContrast">
        <RemoteKeysProvider android={keys.source}>
          <FormFactorProvider value="tv">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
                }}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={EP1_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </RemoteKeysProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 20_000, atMs: manual.now(), rate: 1, durationMs: 120_000 },
      });
      engine.emit({ attempt, type: 'tracks', tracks: TRACKS });
    });

    // High Contrast AAA canvas & CTA tokens
    expect(flatStyle('player-screen')?.backgroundColor).toBe(THEME_PRESETS.highContrast.bgCanvas);
    expect(flatStyle('player-play-pause')?.backgroundColor).toBe(THEME_PRESETS.highContrast.ctaBg);

    // D-pad Down -> focuses 'tracks', Right -> focuses 'settings' with AAA #FACC15 focus ring
    await act(async () => {
      keys.tap(KEY_DOWN);
    });
    await act(async () => {
      keys.tap(KEY_RIGHT);
    });
    expect(flatStyle('player-settings-button')?.borderColor).toBe(
      THEME_PRESETS.highContrast.focusRingColor,
    );

    // Select opens Settings root -> Select enters subtitles subview -> Down -> Select picks s:1
    await act(async () => {
      keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();

    await act(async () => {
      keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-settings-sub-s:1')).toBeTruthy();

    await act(async () => {
      keys.tap(KEY_DOWN);
    });
    await act(async () => {
      keys.tap(KEY_SELECT);
    });
    expect(engine.commands.filter((c) => c.name === 'selectSubtitleTrack').at(-1)?.trackId).toBe(
      's:1',
    );

    // Back returns from subtitles subview to root (still open, no exit)
    await act(async () => {
      keys.tap(KEY_BACK);
    });
    expect(screen.getByTestId('player-settings-row-subtitles')).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();

    // Down x3 (audio -> speed -> stats on VOD) -> Select toggles Stats HUD on -> Up back to speed
    await act(async () => {
      keys.tap(KEY_DOWN);
    });
    await act(async () => {
      keys.tap(KEY_DOWN);
    });
    await act(async () => {
      keys.tap(KEY_DOWN);
    });
    await act(async () => {
      keys.tap(KEY_SELECT);
    });
    expect(screen.getByTestId('player-stats-hud', { includeHiddenElements: true })).toBeTruthy();
    await act(async () => {
      keys.tap(KEY_UP);
    });

    // Back closes Settings root without exiting PlayerScreen (Stats HUD remains visible)
    await act(async () => {
      keys.tap(KEY_BACK);
    });
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    expect(screen.getByTestId('player-stats-hud')).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();

    // Next Back exits PlayerScreen
    await act(async () => {
      keys.tap(KEY_BACK);
    });
    expect(onExit).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});

import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { HostKey } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createFakeService, renderControls } from './player-controls-harness';
import { createManualClock } from './player-test-harness';

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English' },
    { id: 'a:2', language: 'tur', label: 'Turkish' },
  ],
  subtitles: [{ id: 's:1', language: 'eng', label: 'English' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod-1',
  sourceId: 'src-1',
  title: 'Cinema Feature',
  kind: 'vod',
};

const LIVE_TARGET: PlayTarget = {
  itemKey: 'ch-2',
  sourceId: 'src-1',
  title: 'Channel Two',
  kind: 'live',
  previousChannel: {
    itemKey: 'ch-1',
    sourceId: 'src-1',
    title: 'Channel One',
    kind: 'live',
  },
  previousChannelIndex: 0,
  playlist: {
    count: 3,
    currentIndex: 1,
    onChangeIndex: jest.fn(),
    getAt: async (i) => ({
      itemKey: `ch-${i + 1}`,
      sourceId: 'src-1',
      title: `Channel ${i + 1}`,
      kind: 'live',
    }),
  },
};

async function mountDesktopPlayer(opts: { target?: PlayTarget; withDeinterlace?: boolean }) {
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
    anchorOnPlayPause: true,
  });
  const toggleFullscreen = jest.fn();
  const toggleMute = jest.fn();
  const setDeinterlace = jest.fn();
  const onExit = jest.fn();
  const onTargetChange = jest.fn();
  let hostKeyListener: ((key: HostKey) => void) | undefined;

  const catalog = {
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
    ),
  };

  const renderTree = (activeTarget: PlayTarget) => (
    <ThemeProvider preset="obsidianCrimson">
      <TvRemoteProvider>
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{
                open: () => ({
                  engine,
                  renderSurface: () => <View testID="fake-surface" />,
                  toggleFullscreen,
                  toggleMute,
                  ...(opts.withDeinterlace ? { setDeinterlace } : {}),
                  onHostKey: (listener) => {
                    hostKeyListener = listener;
                    return () => {
                      hostKeyListener = undefined;
                    };
                  },
                }),
              }}
              target={activeTarget}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onTargetChange={onTargetChange}
              onExit={onExit}
            />
          </I18nProvider>
        </FormFactorProvider>
      </TvRemoteProvider>
    </ThemeProvider>
  );

  const initialTarget = opts.target ?? VOD_TARGET;
  const view = await render(renderTree(initialTarget));

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  await act(async () => {
    manual.advance(350);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
  await act(async () => {
    if (initialTarget.kind === 'vod') {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 120_000, atMs: manual.now(), rate: 0, durationMs: 300_000 },
      });
    }
    engine.emit({ attempt, type: 'tracks', tracks: SAMPLE_TRACKS });
  });

  return {
    view,
    renderTree,
    manual,
    engine,
    toggleFullscreen,
    toggleMute,
    setDeinterlace,
    onExit,
    onTargetChange,
    emitHostKey: async (key: HostKey) => {
      await act(async () => {
        hostKeyListener?.(key);
      });
    },
  };
}

describe('Wave 4A desktop host-key forwarding (#420) and opt-in Deinterlace (#131)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('#420: executes play-pause, fine/coarse VOD seeks, mute sync, tracks toggle, fullscreen, and back from host keys', async () => {
    const d = await mountDesktopPlayer({ target: VOD_TARGET });

    // play-pause pauses playing VOD, then resumes paused VOD
    await d.emitHostKey('play-pause');
    const pauseCmd = d.engine.commands.filter((c) => c.name === 'pause').at(-1);
    expect(pauseCmd).toBeDefined();
    await act(async () => {
      d.engine.emit({ attempt: pauseCmd?.attempt ?? 1, type: 'state', state: 'paused' });
    });
    await d.emitHostKey('play-pause');
    const playCmd = d.engine.commands.filter((c) => c.name === 'play').at(-1);
    expect(playCmd).toBeDefined();
    await act(async () => {
      d.engine.emit({ attempt: playCmd?.attempt ?? 1, type: 'state', state: 'playing' });
    });

    // Fine seek (-10s / +10s) and coarse seek (-30s / +30s, COARSE_SEEK_MS) starting from 120_000 ms
    await d.emitHostKey('seek-back');
    expect(d.engine.commands.at(-1)).toMatchObject({ name: 'seek', positionMs: 110_000 });

    await d.emitHostKey('seek-forward');
    expect(d.engine.commands.at(-1)).toMatchObject({ name: 'seek', positionMs: 120_000 });

    await d.emitHostKey('seek-coarse-back');
    expect(d.engine.commands.at(-1)).toMatchObject({ name: 'seek', positionMs: 90_000 });

    await d.emitHostKey('seek-coarse-forward');
    expect(d.engine.commands.at(-1)).toMatchObject({ name: 'seek', positionMs: 120_000 });

    // mute toggles React muted state in sync with host toggleMute
    expect(screen.getByTestId('player-mute-button').props.accessibilityLabel).toBe('Mute');
    await d.emitHostKey('mute');
    expect(d.toggleMute).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('player-mute-button').props.accessibilityLabel).toBe('Unmute');
    await d.emitHostKey('mute');
    expect(d.toggleMute).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('player-mute-button').props.accessibilityLabel).toBe('Mute');

    // tracks toggles Settings directly on Subtitles sub-view open & closed
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();
    await d.emitHostKey('tracks');
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(screen.getByTestId('player-settings-sub-s:1')).toBeTruthy();
    await d.emitHostKey('tracks');
    expect(screen.queryByTestId('player-settings-panel')).toBeNull();

    // fullscreen & back remain intact
    await d.emitHostKey('fullscreen');
    expect(d.toggleFullscreen).toHaveBeenCalledTimes(1);
    await d.emitHostKey('back');
    expect(d.onExit).toHaveBeenCalledTimes(1);

    await d.view.unmount();
  });

  it('#420: handles prev-channel and channel zaps on Live while treating VOD seek host keys as no-ops', async () => {
    const d = await mountDesktopPlayer({ target: LIVE_TARGET });

    await d.emitHostKey('seek-back');
    await d.emitHostKey('seek-forward');
    await d.emitHostKey('seek-coarse-back');
    await d.emitHostKey('seek-coarse-forward');
    expect(d.engine.commands.some((c) => c.name === 'seek')).toBe(false);

    await d.emitHostKey('prev-channel');
    await waitFor(() => {
      expect(d.onTargetChange).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'ch-1' }));
    });

    await d.emitHostKey('channel-up');
    await waitFor(() => {
      expect(d.onTargetChange).toHaveBeenCalledWith(expect.objectContaining({ itemKey: 'ch-2' }));
    });

    await d.view.unmount();
  });

  it('#420: treats host-key mute as a no-op when OpenVideoEngine omits toggleMute', async () => {
    const svc = createFakeService({ kind: 'playing' });
    const { hook } = await renderControls(svc, { formFactor: 'desktop', kind: 'vod' });
    expect(hook.result.current.muted).toBe(false);

    await act(async () => {
      hook.result.current.handleHostKey('mute');
    });
    expect(hook.result.current.muted).toBe(false);

    await hook.unmount();
  });

  it('#131: hides Deinterlace when engine lacks setDeinterlace, toggles it when supported, and resets on itemKey change', async () => {
    // 1) Engine without setDeinterlace -> zero dead toggle
    const unsupported = await mountDesktopPlayer({ target: LIVE_TARGET, withDeinterlace: false });
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    expect(screen.getByTestId('player-settings-panel')).toBeTruthy();
    expect(screen.queryByTestId('player-deinterlace-toggle')).toBeNull();
    await unsupported.view.unmount();

    // 2) Engine with setDeinterlace -> toggles true/false inside Advanced settings and resets to false on itemKey change
    const supported = await mountDesktopPlayer({ target: VOD_TARGET, withDeinterlace: true });
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-settings-row-advanced'));
    const toggle = screen.getByTestId('player-deinterlace-toggle');
    expect(toggle.props.accessibilityRole).toBe('switch');
    expect(toggle.props.accessibilityState).toEqual({ checked: false });

    await fireEvent.press(toggle);
    expect(supported.setDeinterlace).toHaveBeenNthCalledWith(1, true);
    expect(screen.getByTestId('player-deinterlace-toggle').props.accessibilityState).toEqual({
      checked: true,
    });

    await fireEvent.press(screen.getByTestId('player-deinterlace-toggle'));
    expect(supported.setDeinterlace).toHaveBeenNthCalledWith(2, false);
    expect(screen.getByTestId('player-deinterlace-toggle').props.accessibilityState).toEqual({
      checked: false,
    });

    // Enable again, then switch target itemKey -> UI state resets to false (mirroring mpv --reset-on-next-file)
    await fireEvent.press(screen.getByTestId('player-deinterlace-toggle'));
    expect(supported.setDeinterlace).toHaveBeenNthCalledWith(3, true);
    expect(screen.getByTestId('player-deinterlace-toggle').props.accessibilityState).toEqual({
      checked: true,
    });

    await supported.view.rerender(
      supported.renderTree({ ...VOD_TARGET, itemKey: 'vod-2', title: 'Next Feature' }),
    );
    await waitFor(() => {
      expect(
        supported.engine.commands.filter((c) => c.name === 'load').length,
      ).toBeGreaterThanOrEqual(2);
    });

    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-settings-row-advanced'));
    expect(screen.getByTestId('player-deinterlace-toggle').props.accessibilityState).toEqual({
      checked: false,
    });
    expect(supported.setDeinterlace).toHaveBeenCalledTimes(3);

    await supported.view.unmount();
  });
});

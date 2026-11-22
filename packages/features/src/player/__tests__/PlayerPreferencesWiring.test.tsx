import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { EngineEvent, PlayerEngine } from '@elv/playback';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost, VideoSurfaceProps } from '../../ports/video-host';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

function makeTestRig() {
  const listeners = new Set<(event: EngineEvent) => void>();
  let currentAttempt = 0;
  const seeks: number[] = [];
  const audioSelections: string[] = [];
  const subtitleSelections: Array<string | null> = [];
  const surfaceProps: VideoSurfaceProps[] = [];

  const engine: PlayerEngine = {
    capabilities: {
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: false,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
    },
    load(cmd) {
      currentAttempt = cmd.attempt;
    },
    retry(attempt) {
      currentAttempt = attempt;
    },
    play() {},
    pause() {},
    seek(_attempt, posMs) {
      seeks.push(posMs);
    },
    selectAudioTrack(_attempt, id) {
      audioSelections.push(id);
    },
    selectSubtitleTrack(_attempt, id) {
      subtitleSelections.push(id);
    },
    stop() {},
    recreate() {},
    release() {},
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  const emit = (
    event:
      | { type: 'state'; state: 'playing' | 'paused' }
      | {
          type: 'clock';
          anchor: { positionMs: number; atMs: number; rate: number; durationMs?: number };
        }
      | {
          type: 'tracks';
          tracks: {
            audio: readonly {
              id: string;
              language?: string;
              label?: string;
              isDefault?: boolean;
            }[];
            subtitles: readonly {
              id: string;
              language?: string;
              label?: string;
              isDefault?: boolean;
              forced?: boolean;
            }[];
            selectedAudioId: string | null;
            selectedSubtitleId: string | null;
          };
        },
  ) => {
    const full = { ...event, attempt: currentAttempt } as EngineEvent;
    for (const l of listeners) l(full);
  };

  const host: VideoHost = {
    open() {
      return {
        engine,
        renderSurface(props) {
          surfaceProps.push(props);
          return <View testID={props.testID} />;
        },
        close() {},
      };
    },
  };

  const catalog = {
    resolveStream: jest.fn(async () => ok({ url: 'http://sim.example.test/vod.mp4', headers: {} })),
    getProgress: jest.fn(async () => null),
    saveProgress: jest.fn(async () =>
      ok({
        profileId: 'default',
        itemKey: 'vod-pref-1',
        sourceId: 's1',
        kind: 'movie' as const,
        title: 'Preference Test Movie',
        subtitle: null,
        logo: null,
        positionMs: 0,
        durationMs: 300_000,
        watched: false,
        updatedAt: 0,
        seriesKey: null,
        season: null,
        episode: null,
      }),
    ),
  };

  return { engine, host, catalog, emit, seeks, audioSelections, subtitleSelections, surfaceProps };
}

function wrapViewport(formFactor: 'phone' | 'desktop', children: ReactElement): ReactElement {
  return (
    <TvRemoteProvider>
      <ViewportProvider
        value={{
          formFactor,
          width: formFactor === 'phone' ? 852 : 1280,
          height: formFactor === 'phone' ? 393 : 800,
          orientation: 'landscape',
        }}
      >
        <I18nProvider i18n={createAppI18n('en')}>
          <ThemeProvider preset="obsidianCrimson">{children}</ThemeProvider>
        </I18nProvider>
      </ViewportProvider>
    </TvRemoteProvider>
  );
}

describe('PlayerScreen preference wiring (#401)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses seekStepSec for skip buttons and defaultResizeMode for initial video surface', async () => {
    const rig = makeTestRig();
    const manual = createManualClock();
    const target: PlayTarget = {
      itemKey: 'vod-pref-1',
      sourceId: 's1',
      title: 'Preference Test Movie',
      kind: 'vod',
    };

    await render(
      wrapViewport(
        'phone',
        <PlayerScreen
          catalog={rig.catalog}
          videoHost={rig.host}
          target={target}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          seekStepSec={15}
          defaultResizeMode="fill"
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(rig.catalog.resolveStream).toHaveBeenCalled());

    await act(async () => {
      rig.emit({ type: 'state', state: 'playing' });
      rig.emit({
        type: 'clock',
        anchor: { positionMs: 60_000, atMs: manual.now(), rate: 1, durationMs: 300_000 },
      });
    });

    expect(rig.surfaceProps[rig.surfaceProps.length - 1]?.resizeMode).toBe('fill');

    await fireEvent.press(screen.getByTestId('player-seek-forward'));
    expect(rig.seeks[rig.seeks.length - 1]).toBe(75_000);

    await fireEvent.press(screen.getByTestId('player-seek-back'));
    expect(rig.seeks[rig.seeks.length - 1]).toBe(60_000);

    await fireEvent.press(screen.getByTestId('player-seek-back'));
    expect(rig.seeks[rig.seeks.length - 1]).toBe(45_000);
  });

  it('auto-selects preferred audio & subtitle tracks once tracks arrive without clobbering later changes', async () => {
    const rig = makeTestRig();
    const target: PlayTarget = {
      itemKey: 'vod-pref-2',
      sourceId: 's1',
      title: 'Multi-Track Movie',
      kind: 'vod',
    };

    await render(
      wrapViewport(
        'desktop',
        <PlayerScreen
          catalog={rig.catalog}
          videoHost={rig.host}
          target={target}
          preferredAudioLang="tr"
          preferredSubtitleLang="en"
          subtitleMode="smart"
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(rig.catalog.resolveStream).toHaveBeenCalled());

    await act(async () => {
      rig.emit({
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a-en', language: 'eng', label: 'English', isDefault: true },
            { id: 'a-tr', language: 'tur', label: 'Turkish' },
          ],
          subtitles: [
            { id: 's-de', language: 'deu', label: 'German' },
            { id: 's-en', language: 'en', label: 'English' },
          ],
          selectedAudioId: 'a-en',
          selectedSubtitleId: null,
        },
      });
    });

    expect(rig.audioSelections).toEqual(['a-tr']);
    expect(rig.subtitleSelections).toEqual(['s-en']);

    await act(async () => {
      rig.emit({
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a-en', language: 'eng', label: 'English', isDefault: true },
            { id: 'a-tr', language: 'tur', label: 'Turkish' },
          ],
          subtitles: [
            { id: 's-de', language: 'deu', label: 'German' },
            { id: 's-en', language: 'en', label: 'English' },
          ],
          selectedAudioId: 'a-en',
          selectedSubtitleId: 's-de',
        },
      });
    });

    expect(rig.audioSelections).toEqual(['a-tr']);
    expect(rig.subtitleSelections).toEqual(['s-en']);
  });

  it('disables subtitles when subtitleMode is off and lets target override global preferredAudioLang', async () => {
    const rig = makeTestRig();
    const target = {
      itemKey: 'vod-pref-3',
      sourceId: 's1',
      title: 'Override Movie',
      kind: 'vod' as const,
      preferredAudioLang: 'de',
    } as PlayTarget;

    await render(
      wrapViewport(
        'desktop',
        <PlayerScreen
          catalog={rig.catalog}
          videoHost={rig.host}
          target={target}
          preferredAudioLang="tr"
          preferredSubtitleLang="en"
          subtitleMode="off"
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(rig.catalog.resolveStream).toHaveBeenCalled());

    await act(async () => {
      rig.emit({
        type: 'tracks',
        tracks: {
          audio: [
            { id: 'a-tr', language: 'tur', label: 'Turkish' },
            { id: 'a-de', language: 'deu', label: 'German' },
          ],
          subtitles: [{ id: 's-en', language: 'en', label: 'English', isDefault: true }],
          selectedAudioId: 'a-tr',
          selectedSubtitleId: 's-en',
        },
      });
    });

    expect(rig.audioSelections).toEqual(['a-de']);
    expect(rig.subtitleSelections).toEqual([null]);
  });
});

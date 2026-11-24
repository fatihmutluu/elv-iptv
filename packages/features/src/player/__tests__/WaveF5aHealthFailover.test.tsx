import type { WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  createConnectionTracker,
  createIdleProbeController,
  createStreamHealthCache,
  createStreamHealthScorer,
  type EngineEvent,
  type LoadCommand,
  type PlayerEngine,
  type StreamRequest,
} from '@elv/playback';
import { I18nProvider, ThemeProvider, TvRemoteProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import type { OpenVideoEngine, VideoHost } from '../../ports/video-host';
import { StreamHealthProvider } from '../../shared';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

function createFakeEngine() {
  const listeners = new Set<(ev: EngineEvent) => void>();
  const loads: LoadCommand[] = [];
  let currentAttempt = 0;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load(cmd) {
      currentAttempt = cmd.attempt;
      loads.push(cmd);
    },
    retry(attempt) {
      currentAttempt = attempt;
    },
    recreate(attempt) {
      currentAttempt = attempt;
    },
    play() {},
    pause() {},
    seek() {},
    stop() {},
    release() {},
  };
  const emit = (ev: EngineEvent) => {
    for (const l of [...listeners]) l(ev);
  };
  const videoHost: VideoHost = {
    open(): OpenVideoEngine {
      return {
        engine,
        renderSurface: () => <View testID="fake-video-surface" />,
      };
    },
  };
  return { engine, loads, emit, videoHost, getAttempt: () => currentAttempt };
}

function wrapWithHealth(
  node: ReactElement,
  health?: {
    readonly healthCache?: ReturnType<typeof createStreamHealthCache>;
    readonly healthScorer?: ReturnType<typeof createStreamHealthScorer>;
    readonly idleProbeController?: ReturnType<typeof createIdleProbeController>;
    readonly connectionTracker?: ReturnType<typeof createConnectionTracker>;
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
              {...(health?.healthScorer !== undefined ? { healthScorer: health.healthScorer } : {})}
              {...(health?.idleProbeController !== undefined
                ? { idleProbeController: health.idleProbeController }
                : {})}
              {...(health?.connectionTracker !== undefined
                ? { connectionTracker: health.connectionTracker }
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

describe('Wave F5A PlayerScreen health cache, idle-probe abort, outcome reporting & connection-safe failover (#157, #167, #195, #317)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('wires healthCache, idleProbeController abort on tune, reportStreamOutcome, and connection-safe canAcquireAlternate', async () => {
    const manual = createManualClock();
    const healthCache = createStreamHealthCache({ clock: { now: manual.now } });
    const healthScorer = createStreamHealthScorer({ clock: { now: manual.now } });
    const idleProbeController = createIdleProbeController();
    const connectionTracker = createConnectionTracker();
    connectionTracker.acquire('account-B', 'other-stream');

    const probeSignal = idleProbeController.beginProbe({ maxConnections: 2 });
    expect(probeSignal?.aborted).toBe(false);

    const { loads, emit, videoHost, getAttempt } = createFakeEngine();
    const reportStreamOutcome = jest.fn();

    const primaryStream: StreamRequest = {
      url: 'https://primary.example/live/10.ts',
      headers: {},
      sourceId: 's1',
      accountKey: 'account-A',
      maxConnections: 1,
      alternates: [
        {
          url: 'https://saturated.example/live/10.ts',
          headers: {},
          sourceId: 's2',
          accountKey: 'account-B',
          maxConnections: 1,
        },
        {
          url: 'https://backup.example/live/10.ts',
          headers: {},
          sourceId: 's3',
          accountKey: 'account-C',
          maxConnections: 1,
        },
      ],
    };

    const target: PlayTarget = {
      itemKey: 'x:s1:live:10',
      sourceId: 's1',
      accountKey: 'account-A',
      kind: 'live',
      title: 'Channel 10',
    };

    const catalog = {
      resolveStream: jest.fn(async () => ok(primaryStream)),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok({} as WatchProgressRow)),
      reportStreamOutcome,
    };

    await render(
      wrapWithHealth(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={target}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
        { healthCache, healthScorer, idleProbeController, connectionTracker },
      ),
    );

    await waitFor(() => {
      expect(loads.length).toBeGreaterThanOrEqual(1);
    });

    expect(probeSignal?.aborted).toBe(true);

    const firstAttempt = loads[0]?.attempt ?? 1;
    await act(async () => {
      emit({ type: 'firstFrame', attempt: firstAttempt, atMs: manual.now() + 250 });
    });

    expect(healthCache.get(target.itemKey)?.status).toBe('healthy');
    expect(reportStreamOutcome).toHaveBeenCalledWith('s1', 'https://primary.example', true);

    for (let step = 0; step < 8; step += 1) {
      if (loads.some((l) => l.url === 'https://backup.example/live/10.ts')) break;
      await act(async () => {
        emit({
          type: 'error',
          attempt: getAttempt(),
          error: { code: 'network' },
        });
        manual.advance(15_000);
      });
    }

    expect(reportStreamOutcome).toHaveBeenCalledWith('s1', 'https://primary.example', false);
    const loadedUrls = loads.map((l) => l.url);
    expect(loadedUrls).not.toContain('https://saturated.example/live/10.ts');
    expect(loadedUrls).toContain('https://backup.example/live/10.ts');
  });

  it('strips Xtream credentials/paths to HTTP(S) origin and skips non-HTTP streams in reportStreamOutcome (#317)', async () => {
    const manual = createManualClock();
    const { loads, emit, videoHost } = createFakeEngine();
    const reportStreamOutcome = jest.fn();

    const target: PlayTarget = {
      itemKey: 'x:s1:live:42',
      sourceId: 's1',
      accountKey: 'account-A',
      kind: 'live',
      title: 'Channel 42',
    };

    const xtreamStream: StreamRequest = {
      url: `${['http://u:p@mirror.example.test:8080', 'live', 'demo', 'cred', '42.ts'].join('/')}?token=xyz`,
      headers: {},
      sourceId: 's1',
      accountKey: 'account-A',
      maxConnections: 1,
    };

    const catalog = {
      resolveStream: jest.fn(async () => ok(xtreamStream)),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async () => ok({} as WatchProgressRow)),
      reportStreamOutcome,
    };

    const view = await render(
      wrapWithHealth(
        <PlayerScreen
          catalog={catalog}
          videoHost={videoHost}
          target={target}
          clock={{ now: manual.now }}
          timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
          onExit={jest.fn()}
        />,
      ),
    );

    await waitFor(() => {
      expect(loads.length).toBeGreaterThanOrEqual(1);
    });

    await act(async () => {
      emit({ type: 'firstFrame', attempt: loads[0]?.attempt ?? 1, atMs: manual.now() + 100 });
    });

    expect(reportStreamOutcome).toHaveBeenCalledTimes(1);
    expect(reportStreamOutcome).toHaveBeenCalledWith('s1', 'http://mirror.example.test:8080', true);
    const reportedUrl = reportStreamOutcome.mock.calls[0]?.[1] as string;
    expect(reportedUrl).not.toContain('alice');
    expect(reportedUrl).not.toContain('s3cr3t');
    expect(reportedUrl).not.toContain('user:pass');
    expect(reportedUrl).not.toContain('/live/');
    await view.unmount();

    // Non-HTTP(S) schemes (rtsp:// and udp://) must NEVER invoke reportStreamOutcome
    for (const nonHttpUrl of ['rtsp://cam.example.test:554/stream1', 'udp://239.0.0.1:1234']) {
      const nonHttpReport = jest.fn();
      const nonHttpEngine = createFakeEngine();
      const nonHttpCatalog = {
        resolveStream: jest.fn(async () =>
          ok<StreamRequest>({
            url: nonHttpUrl,
            headers: {},
            sourceId: 's1',
            accountKey: 'account-A',
            maxConnections: 1,
          }),
        ),
        getProgress: jest.fn(async () => null),
        saveProgress: jest.fn(async () => ok({} as WatchProgressRow)),
        reportStreamOutcome: nonHttpReport,
      };
      const nonHttpView = await render(
        wrapWithHealth(
          <PlayerScreen
            catalog={nonHttpCatalog}
            videoHost={nonHttpEngine.videoHost}
            target={target}
            clock={{ now: manual.now }}
            timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
            onExit={jest.fn()}
          />,
        ),
      );
      await waitFor(() => {
        expect(nonHttpEngine.loads.length).toBeGreaterThanOrEqual(1);
      });
      await act(async () => {
        nonHttpEngine.emit({
          type: 'firstFrame',
          attempt: nonHttpEngine.loads[0]?.attempt ?? 1,
          atMs: manual.now() + 100,
        });
      });
      expect(nonHttpReport).not.toHaveBeenCalled();
      await nonHttpView.unmount();
    }
  });
});

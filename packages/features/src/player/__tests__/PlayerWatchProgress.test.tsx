import type { SaveProgressInput, WatchProgressRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { AppLifecyclePort, AppLifecycleState } from '../../ports/app-lifecycle';
import type { PlayTarget } from '../../ports/play-target';
import type { VideoHost } from '../../ports/video-host';
import { PlayerScreen, type PlayerScreenProps } from '../PlayerScreen';
import { PROGRESS_SAVE_INTERVAL_MS, resolveVodStartPositionMs } from '../useWatchProgressSync';
import { createManualClock } from './player-test-harness';

function createFakeLifecycle() {
  const listeners = new Set<(s: AppLifecycleState) => void>();
  const port: AppLifecyclePort = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    port,
    emit(state: AppLifecycleState) {
      for (const l of [...listeners]) l(state);
    },
  };
}

function makeProgressRow(overrides: Partial<WatchProgressRow> = {}): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'x:src-1:vod:201',
    kind: 'movie',
    title: 'Cinema Feature',
    subtitle: null,
    logo: null,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 65_000,
    durationMs: 180_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function mockSaveResult(input: SaveProgressInput) {
  return ok(
    makeProgressRow({
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
    }),
  );
}

function wrapPlayer(
  props: Omit<PlayerScreenProps, 'onExit'> & { onExit?: PlayerScreenProps['onExit'] },
) {
  return (
    <FormFactorProvider value="desktop">
      <I18nProvider i18n={createAppI18n('en')}>
        <PlayerScreen onExit={jest.fn()} {...props} />
      </I18nProvider>
    </FormFactorProvider>
  );
}

describe('resolveVodStartPositionMs', () => {
  it('returns synchronously for live targets, explicit startPositionMs, and catalogs without getProgress', () => {
    const getProgress = jest.fn(async () => makeProgressRow());
    expect(
      resolveVodStartPositionMs(
        { itemKey: 'ch:1', sourceId: 's1', title: 'Live', kind: 'live' },
        { getProgress },
      ),
    ).toBeUndefined();
    expect(
      resolveVodStartPositionMs(
        { itemKey: 'v:1', sourceId: 's1', title: 'Movie', kind: 'vod', startPositionMs: 32_499.6 },
        { getProgress },
      ),
    ).toBe(32_500);
    expect(
      resolveVodStartPositionMs(
        { itemKey: 'v:1', sourceId: 's1', title: 'Movie', kind: 'vod' },
        {},
      ),
    ).toBeUndefined();
    expect(getProgress).not.toHaveBeenCalled();
  });

  it('applies 5s smart rewind and returns undefined for watched, <10s, null, or rejected lookups', async () => {
    const vod = { itemKey: 'v:1', sourceId: 's1', title: 'Movie', kind: 'vod' as const };
    await expect(
      resolveVodStartPositionMs(vod, {
        getProgress: async () => makeProgressRow({ positionMs: 65_000, watched: false }),
      }),
    ).resolves.toBe(60_000);
    await expect(
      resolveVodStartPositionMs(vod, {
        getProgress: async () => makeProgressRow({ positionMs: 9_999, watched: false }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveVodStartPositionMs(vod, {
        getProgress: async () => makeProgressRow({ positionMs: 170_000, watched: true }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveVodStartPositionMs(vod, { getProgress: async () => null }),
    ).resolves.toBeUndefined();
    await expect(
      resolveVodStartPositionMs(vod, {
        getProgress: async () => {
          throw new Error('storage-failure');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe('PlayerScreen VOD watch progress persistence and smart resume (#14)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resumes in-progress VOD with 5-second smart rewind (65s -> 60s)', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loadSpy = jest.spyOn(engine, 'load');
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => makeProgressRow({ positionMs: 65_000, watched: false })),
      saveProgress: jest.fn(async (input: SaveProgressInput) => mockSaveResult(input)),
    };

    const view = await render(
      wrapPlayer({
        catalog,
        videoHost: { open: () => ({ engine, renderSurface: () => <View /> }) },
        target: {
          itemKey: 'x:src-1:vod:201',
          sourceId: 'src-1',
          title: 'Cinema Feature',
          kind: 'vod',
          itemKind: 'movie',
        },
        clock: { now: manual.now },
        timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
      }),
    );

    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });
    expect(catalog.getProgress).toHaveBeenCalledWith('x:src-1:vod:201');
    expect(loadSpy.mock.calls[0]?.[0]).toMatchObject({ kind: 'vod', startMs: 60_000 });
    await view.unmount();
  });

  it('reopens watched VOD from start (omitting startMs) and honors explicit startPositionMs without querying getProgress', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loadSpy = jest.spyOn(engine, 'load');
    const videoHost: VideoHost = { open: () => ({ engine, renderSurface: () => <View /> }) };
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => makeProgressRow({ positionMs: 170_000, watched: true })),
      saveProgress: jest.fn(async (input: SaveProgressInput) => mockSaveResult(input)),
    };
    const common = {
      catalog,
      videoHost,
      clock: { now: manual.now },
      timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };

    const view = await render(
      wrapPlayer({
        ...common,
        target: { itemKey: 'x:src-1:vod:202', sourceId: 'src-1', title: 'Watched', kind: 'vod' },
      }),
    );
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });
    expect(loadSpy.mock.calls[0]?.[0]).not.toHaveProperty('startMs');

    await view.rerender(
      wrapPlayer({
        ...common,
        target: {
          itemKey: 'x:src-1:vod:203',
          sourceId: 'src-1',
          title: 'Explicit Start',
          kind: 'vod',
          startPositionMs: 42_000,
        },
      }),
    );
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(2);
    });
    expect(catalog.getProgress).toHaveBeenCalledTimes(1);
    expect(loadSpy.mock.calls[1]?.[0]).toMatchObject({ kind: 'vod', startMs: 42_000 });
    await view.unmount();
  });

  it('quantizes periodic persistence to 10s intervals (25s playback -> 2 writes, skipping <1s deltas) and forwards episode metadata', async () => {
    expect(PROGRESS_SAVE_INTERVAL_MS).toBe(10_000);
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async (input: SaveProgressInput) => mockSaveResult(input)),
    };

    const view = await render(
      wrapPlayer({
        catalog,
        videoHost: { open: () => ({ engine, renderSurface: () => <View /> }) },
        target: {
          itemKey: 'x:src-1:ep:501',
          sourceId: 'src-1',
          title: 'Pilot',
          subtitle: 'S01E01',
          logo: 'http://sim.example.test/poster.jpg',
          seriesKey: 'x:src-1:series:50',
          season: 1,
          episode: 1,
          kind: 'vod',
          itemKind: 'episode',
        },
        clock: { now: manual.now },
        timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
      }),
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
        anchor: { positionMs: 15_000, atMs: manual.now(), rate: 1, durationMs: 300_000 },
      });
    });

    expect(catalog.saveProgress).toHaveBeenCalledTimes(0);
    await act(async () => {
      manual.advance(25_000);
    });

    expect(catalog.saveProgress).toHaveBeenCalledTimes(2);
    expect(catalog.saveProgress.mock.calls[0]?.[0]).toMatchObject({
      sourceId: 'src-1',
      itemKey: 'x:src-1:ep:501',
      kind: 'episode',
      title: 'Pilot',
      subtitle: 'S01E01',
      logo: 'http://sim.example.test/poster.jpg',
      seriesKey: 'x:src-1:series:50',
      season: 1,
      episode: 1,
      positionMs: 25_000,
      durationMs: 300_000,
    });
    expect(catalog.saveProgress.mock.calls[1]?.[0]).toMatchObject({
      positionMs: 35_000,
      durationMs: 300_000,
    });

    // Stalled playback (<1s movement) skips redundant periodic writes
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 35_400, atMs: manual.now(), rate: 0, durationMs: 300_000 },
      });
      manual.advance(10_000);
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it('flushes immediately on pause, seek, background, ended (even <10s), target switch, and unmount with zero timer leaks', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const lifecycle = createFakeLifecycle();
    const callOrder: string[] = [];
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => null),
      saveProgress: jest.fn(async (input: SaveProgressInput) => {
        callOrder.push(
          `save:${input.itemKey}:${input.positionMs}:${String(input.watched ?? false)}`,
        );
        return mockSaveResult(input);
      }),
    };
    const origStop = engine.stop.bind(engine);
    jest.spyOn(engine, 'stop').mockImplementation((attempt) => {
      callOrder.push('engine.stop');
      origStop(attempt);
    });

    const videoHost: VideoHost = { open: () => ({ engine, renderSurface: () => <View /> }) };
    const common = {
      catalog,
      videoHost,
      appLifecycle: lifecycle.port,
      clock: { now: manual.now },
      timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };

    const movieA: PlayTarget = {
      itemKey: 'x:src-1:vod:a',
      sourceId: 'src-1',
      title: 'Movie A',
      kind: 'vod',
    };
    const view = await render(wrapPlayer({ ...common, target: movieA }));

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const loadAttempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt: loadAttempt,
        type: 'clock',
        anchor: { positionMs: 12_000, atMs: manual.now(), rate: 1, durationMs: 200_000 },
      });
      manual.advance(3_000);
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(0);

    // 1. Immediate flush on pause
    await fireEvent.press(screen.getByTestId('player-play-pause'));
    const pauseAttempt = engine.commands.filter((c) => c.name === 'pause').at(-1)?.attempt ?? 2;
    await act(async () => {
      engine.emit({ attempt: pauseAttempt, type: 'state', state: 'paused' });
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(1);
    expect(catalog.saveProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      itemKey: 'x:src-1:vod:a',
      positionMs: 15_000,
    });

    // 2. Immediate flush on explicit seek (+10s -> 25_000ms)
    await fireEvent.press(screen.getByTestId('player-seek-forward'));
    expect(catalog.saveProgress).toHaveBeenCalledTimes(2);
    expect(catalog.saveProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      itemKey: 'x:src-1:vod:a',
      positionMs: 25_000,
    });

    // 3. Immediate flush on background BEFORE engine.stop()
    await fireEvent.press(screen.getByTestId('player-play-pause'));
    const playAttempt = engine.commands.filter((c) => c.name === 'play').at(-1)?.attempt ?? 3;
    await act(async () => {
      engine.emit({ attempt: playAttempt, type: 'state', state: 'playing' });
      engine.emit({
        attempt: playAttempt,
        type: 'clock',
        anchor: { positionMs: 25_000, atMs: manual.now(), rate: 1, durationMs: 200_000 },
      });
      manual.advance(4_000);
    });
    callOrder.length = 0;
    await act(async () => {
      lifecycle.emit('background');
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(3);
    expect(callOrder[0]).toBe('save:x:src-1:vod:a:29000:false');
    expect(callOrder[1]).toBe('engine.stop');

    // 4. Immediate flush on target switch BEFORE clearing state
    await act(async () => {
      lifecycle.emit('active');
    });
    await waitFor(() => {
      expect(engine.commands.filter((c) => c.name === 'load').length).toBeGreaterThanOrEqual(2);
    });
    await act(async () => {
      manual.advance(350);
    });
    const resumeAttempt = engine.commands.filter((c) => c.name === 'load').at(-1)?.attempt ?? 4;
    await act(async () => {
      engine.emit({
        attempt: resumeAttempt,
        type: 'clock',
        anchor: { positionMs: 29_000, atMs: manual.now(), rate: 1, durationMs: 200_000 },
      });
      manual.advance(5_000);
    });

    await view.rerender(
      wrapPlayer({
        ...common,
        target: {
          itemKey: 'x:src-1:vod:b',
          sourceId: 'src-1',
          title: 'Short Clip B',
          kind: 'vod',
        },
      }),
    );
    expect(catalog.saveProgress).toHaveBeenCalledTimes(4);
    expect(catalog.saveProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      itemKey: 'x:src-1:vod:a',
      positionMs: 34_000,
    });

    // 5. Immediate flush on ended (watched: true, even when duration < 10s)
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('x:src-1:vod:b');
    });
    await act(async () => {
      manual.advance(350);
    });
    const bAttempt = engine.commands.filter((c) => c.name === 'load').at(-1)?.attempt ?? 5;
    await act(async () => {
      engine.emit({
        attempt: bAttempt,
        type: 'clock',
        anchor: { positionMs: 4_500, atMs: manual.now(), rate: 1, durationMs: 5_000 },
      });
      engine.emit({ attempt: bAttempt, type: 'state', state: 'ended' });
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(5);
    expect(catalog.saveProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      itemKey: 'x:src-1:vod:b',
      positionMs: 5_000,
      durationMs: 5_000,
      watched: true,
    });

    // 6. Immediate flush on unmount with zero leaked timers
    await view.rerender(
      wrapPlayer({
        ...common,
        target: { itemKey: 'x:src-1:vod:c', sourceId: 'src-1', title: 'Movie C', kind: 'vod' },
      }),
    );
    await waitFor(() => {
      expect(catalog.resolveStream).toHaveBeenLastCalledWith('x:src-1:vod:c');
    });
    await act(async () => {
      manual.advance(350);
    });
    const cAttempt = engine.commands.filter((c) => c.name === 'load').at(-1)?.attempt ?? 6;
    await act(async () => {
      engine.emit({
        attempt: cAttempt,
        type: 'clock',
        anchor: { positionMs: 20_000, atMs: manual.now(), rate: 1, durationMs: 180_000 },
      });
      manual.advance(4_000);
    });
    const savesBeforeUnmount = catalog.saveProgress.mock.calls.length;
    await view.unmount();

    expect(catalog.saveProgress).toHaveBeenCalledTimes(savesBeforeUnmount + 1);
    expect(catalog.saveProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      itemKey: 'x:src-1:vod:c',
      positionMs: 24_000,
      durationMs: 180_000,
    });
    await act(async () => {
      manual.advance(30_000);
    });
    expect(catalog.saveProgress).toHaveBeenCalledTimes(savesBeforeUnmount + 1);
  });

  it('never reads or writes watch progress for live channels', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const lifecycle = createFakeLifecycle();
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.ts`, headers: {} }),
      ),
      getProgress: jest.fn(async () => makeProgressRow({ kind: 'live', positionMs: 60_000 })),
      saveProgress: jest.fn(async (input: SaveProgressInput) => mockSaveResult(input)),
    };

    const view = await render(
      wrapPlayer({
        catalog,
        videoHost: { open: () => ({ engine, renderSurface: () => <View /> }) },
        appLifecycle: lifecycle.port,
        target: {
          itemKey: 'x:src-1:live:101',
          sourceId: 'src-1',
          title: 'Live News HD',
          kind: 'live',
        },
        clock: { now: manual.now },
        timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
      }),
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(30_000);
      lifecycle.emit('background');
      lifecycle.emit('active');
    });
    await view.unmount();

    expect(catalog.getProgress).not.toHaveBeenCalled();
    expect(catalog.saveProgress).not.toHaveBeenCalled();
  });

  it('ignores stale getProgress responses after target switch and after unmount', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const loadSpy = jest.spyOn(engine, 'load');
    const deferred = new Map<string, (row: WatchProgressRow | null) => void>();
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(
        (itemKey: string) =>
          new Promise<WatchProgressRow | null>((resolve) => {
            deferred.set(itemKey, resolve);
          }),
      ),
      saveProgress: jest.fn(async (input: SaveProgressInput) => mockSaveResult(input)),
    };
    const common = {
      catalog,
      videoHost: { open: () => ({ engine, renderSurface: () => <View /> }) },
      clock: { now: manual.now },
      timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
    };

    const view = await render(
      wrapPlayer({
        ...common,
        target: { itemKey: 'x:src-1:vod:stale-a', sourceId: 'src-1', title: 'A', kind: 'vod' },
      }),
    );
    expect(catalog.getProgress).toHaveBeenCalledWith('x:src-1:vod:stale-a');

    await view.rerender(
      wrapPlayer({
        ...common,
        target: { itemKey: 'x:src-1:vod:fresh-b', sourceId: 'src-1', title: 'B', kind: 'vod' },
      }),
    );
    await act(async () => {
      deferred.get('x:src-1:vod:fresh-b')?.(
        makeProgressRow({ itemKey: 'x:src-1:vod:fresh-b', positionMs: 55_000, watched: false }),
      );
    });
    await waitFor(() => {
      expect(loadSpy).toHaveBeenCalledTimes(1);
    });
    expect(catalog.resolveStream).toHaveBeenCalledWith('x:src-1:vod:fresh-b');
    expect(loadSpy.mock.calls[0]?.[0]).toMatchObject({ startMs: 50_000 });

    await act(async () => {
      deferred.get('x:src-1:vod:stale-a')?.(
        makeProgressRow({ itemKey: 'x:src-1:vod:stale-a', positionMs: 95_000, watched: false }),
      );
    });
    expect(catalog.resolveStream).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(catalog.saveProgress).not.toHaveBeenCalled();

    await view.rerender(
      wrapPlayer({
        ...common,
        target: { itemKey: 'x:src-1:vod:unmount-c', sourceId: 'src-1', title: 'C', kind: 'vod' },
      }),
    );
    await view.unmount();

    await act(async () => {
      deferred.get('x:src-1:vod:unmount-c')?.(
        makeProgressRow({ itemKey: 'x:src-1:vod:unmount-c', positionMs: 75_000, watched: false }),
      );
    });
    expect(catalog.resolveStream).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(catalog.saveProgress).not.toHaveBeenCalled();
  });

  it('isolates getProgress and saveProgress rejections without interrupting playback', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const catalog = {
      resolveStream: jest.fn(async (key: string) =>
        ok({ url: `http://sim.example.test/${key}.mp4`, headers: {} }),
      ),
      getProgress: jest.fn(async () => {
        throw new Error('db-read-error');
      }),
      saveProgress: jest.fn(async () => {
        throw new Error('db-write-error');
      }),
    };

    const view = await render(
      wrapPlayer({
        catalog,
        videoHost: { open: () => ({ engine, renderSurface: () => <View /> }) },
        target: {
          itemKey: 'x:src-1:vod:resilient',
          sourceId: 'src-1',
          title: 'Resilient Movie',
          kind: 'vod',
        },
        clock: { now: manual.now },
        timers: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
      }),
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
      manual.advance(10_000);
    });

    expect(catalog.saveProgress).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('Playing');
    await view.unmount();
  });
});

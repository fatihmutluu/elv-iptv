import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { PlayTarget } from '../ports/play-target';
import { runExternalPlayerHandoff } from './useExternalPlayerHandoff';

const VOD_TARGET: PlayTarget = {
  itemKey: 'vod:src1:42',
  sourceId: 'src1',
  title: 'Example Film',
  kind: 'vod',
  itemKind: 'movie',
};

describe('runExternalPlayerHandoff (#406)', () => {
  it('tears down preview and active player before launching, then saves returned VOD progress', async () => {
    const order: string[] = [];
    const progressRow = {
      profileId: 'default',
      sourceId: 'src1',
      itemKey: 'vod:src1:42',
      kind: 'movie' as const,
      title: 'Example Film',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 30_000,
      durationMs: 600_000,
      watched: false,
      updatedAt: 0,
    };
    const saveProgress = vi.fn(async () => ok(progressRow));
    const onProgressSaved = vi.fn();
    const onReleaseConnection = vi.fn(() => {
      order.push('release');
    });

    const res = await runExternalPlayerHandoff({
      target: VOD_TARGET,
      catalog: {
        resolveStream: vi.fn(async () => {
          order.push('resolve');
          return ok({ url: 'https://stream.example.test/movie.mp4', headers: {} });
        }),
        getProgress: vi.fn(async () => progressRow),
        saveProgress,
      },
      externalPlayer: {
        isSupported: true,
        launch: vi.fn(async () => {
          order.push('launch');
          return {
            launched: true,
            positionMs: 550_000,
            durationMs: 600_000,
            completed: false,
          };
        }),
      },
      stopEmbeddedPreview: async () => {
        order.push('stopPreview');
      },
      stopActivePlayer: async () => {
        order.push('stopActive');
      },
      onReleaseConnection,
      onProgressSaved,
    });

    expect(res).toEqual({ ok: true });
    expect(order).toEqual(['stopPreview', 'stopActive', 'release', 'resolve', 'launch']);
    expect(saveProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'vod:src1:42',
        positionMs: 550_000,
        durationMs: 600_000,
        watched: true,
      }),
    );
    expect(onProgressSaved).toHaveBeenCalledTimes(1);
  });

  it('returns { ok: false } when external launch fails without saving progress', async () => {
    const saveProgress = vi.fn(async () =>
      ok({
        profileId: 'default',
        sourceId: 'src1',
        itemKey: 'vod:src1:42',
        kind: 'movie' as const,
        title: 'Example Film',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 0,
        durationMs: 0,
        watched: false,
        updatedAt: 0,
      }),
    );
    const res = await runExternalPlayerHandoff({
      target: VOD_TARGET,
      catalog: {
        resolveStream: vi.fn(async () =>
          ok({ url: 'https://stream.example.test/movie.mp4', headers: {} }),
        ),
        saveProgress,
      },
      externalPlayer: {
        isSupported: true,
        launch: vi.fn(async () => ({ launched: false, errorCode: 'no_handler' })),
      },
    });

    expect(res).toEqual({ ok: false });
    expect(saveProgress).not.toHaveBeenCalled();
  });

  it('returns { ok: false } without crashing when externalPlayer.launch throws or returns null', async () => {
    const onReleaseConnection = vi.fn();
    const throwingRes = await runExternalPlayerHandoff({
      target: VOD_TARGET,
      catalog: {
        resolveStream: vi.fn(async () =>
          ok({ url: 'https://stream.example.test/movie.mp4', headers: {} }),
        ),
      },
      externalPlayer: {
        isSupported: true,
        launch: vi.fn(async () => {
          throw new Error('native bridge crash');
        }),
      },
      onReleaseConnection,
    });
    expect(throwingRes).toEqual({ ok: false });
    expect(onReleaseConnection).toHaveBeenCalledTimes(1);

    const nullRes = await runExternalPlayerHandoff({
      target: VOD_TARGET,
      catalog: {
        resolveStream: vi.fn(async () =>
          ok({ url: 'https://stream.example.test/movie.mp4', headers: {} }),
        ),
      },
      externalPlayer: {
        isSupported: true,
        launch: vi.fn(
          async () =>
            null as unknown as { readonly launched: boolean; readonly errorCode?: string },
        ),
      },
    });
    expect(nullRes).toEqual({ ok: false });
  });

  it('still unmounts active mini-player and releases connection when stopActivePlayer throws', async () => {
    let activePlayTarget: PlayTarget | null = VOD_TARGET;
    const stopActivePlayback = vi.fn(() => {
      activePlayTarget = null;
    });

    const res = await runExternalPlayerHandoff({
      target: VOD_TARGET,
      catalog: {
        resolveStream: vi.fn(async () => {
          expect(activePlayTarget).toBeNull();
          return ok({ url: 'https://stream.example.test/movie.mp4', headers: {} });
        }),
      },
      externalPlayer: {
        isSupported: true,
        launch: vi.fn(async () => ({ launched: true })),
      },
      stopActivePlayer: vi.fn(async () => {
        throw new Error('stop error');
      }),
      onReleaseConnection: stopActivePlayback,
    });

    expect(res).toEqual({ ok: true });
    expect(stopActivePlayback).toHaveBeenCalledTimes(1);
    expect(activePlayTarget).toBeNull();
  });
});

import { type ClientRequest, request as httpRequest } from 'node:http';
import { createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { createFetchHttpClient, createPlaybackGuard } from '@elv/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { activeChildren, findFfmpeg, MEDIA_SKIP_MARKER } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';

const ffmpeg = findFfmpeg();
if (ffmpeg === null && process.env.CI === 'true') {
  throw new Error('ffmpeg is required in CI');
}
const withFfmpeg = ffmpeg === null ? describe.skip : describe;
if (ffmpeg === null) process.stderr.write(`source-remove-stream: ${MEDIA_SKIP_MARKER}\n`);

function createLiveStreamPlayer() {
  let activeSourceId: string | undefined;
  let activeReq: ClientRequest | null = null;
  let playing = false;

  const stop = (): void => {
    playing = false;
    activeSourceId = undefined;
    if (activeReq !== null) {
      activeReq.destroy();
      activeReq = null;
    }
  };

  return {
    isPlaying: () => playing,
    getSourceId: () => activeSourceId,
    stop,
    open(sourceId: string, url: string, headers: Record<string, string>): void {
      stop();
      activeSourceId = sourceId;
      const req = httpRequest(url, { headers }, (res) => {
        res.on('data', () => {
          if (activeReq === req) playing = true;
        });
      });
      req.on('error', () => {
        // Expected on synchronous destroy() during stop()
      });
      req.end();
      activeReq = req;
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

withFfmpeg('removeSource synchronous stream socket close (#67)', () => {
  const openSims: SimHandle[] = [];

  afterEach(async () => {
    await Promise.all(openSims.splice(0).map((s) => s.close()));
    await waitFor(() => activeChildren() === 0, 3000);
  });

  it('stops active stream session synchronously on removeSource and closes HTTP socket within 1 s', async () => {
    const sim = await startSim({ port: 0, mediaSeconds: 2 });
    openSims.push(sim);

    const t = testDb();
    await openCatalog(t.db);
    const guard = createPlaybackGuard();
    const catalog = createCatalogService({
      db: t.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: createFetchHttpClient(fetch),
      clock: () => Date.now(),
      newId: () => 'sim-src',
      beforeRemoveSource: (id) => guard.stopIfUsingSource(id),
    });

    const added = await catalog.addSource({
      kind: 'xtream',
      name: 'Sim',
      server: sim.url,
      username: 'demo',
      password: 'demo',
    });
    if (!added.ok) throw new Error('addSource failed');
    const imported = await catalog.importSource('sim-src');
    expect(imported.ok).toBe(true);

    const cats = await catalog.categories('sim-src', 'live');
    const channels = await catalog.items(cats[0]?.id ?? '', 0, 5);
    const firstChannel = channels[0];
    if (firstChannel === undefined) throw new Error('no live channels');

    const stream = await catalog.resolveStream(firstChannel.key);
    if (!stream.ok) throw new Error('resolveStream failed');

    const player = createLiveStreamPlayer();
    const unregister = guard.registerSession?.({
      getSourceId: () => player.getSourceId(),
      stop: () => player.stop(),
    });

    try {
      player.open('sim-src', stream.value.url, stream.value.headers);
      await waitFor(() => player.isPlaying(), 10_000);
      expect(sim.requests().filter((r) => r.path.startsWith('/live/'))).toHaveLength(0);

      const removeStartedAt = performance.now();
      const removePromise = catalog.removeSource('sim-src');
      // Stream must already be stopped synchronously before removeSource settles!
      expect(player.isPlaying()).toBe(false);
      expect((await removePromise).ok).toBe(true);

      await waitFor(() => sim.requests().some((r) => r.path.startsWith('/live/')), 1000);
      const closeElapsedMs = performance.now() - removeStartedAt;
      expect(closeElapsedMs).toBeLessThan(1000);
    } finally {
      unregister?.();
      player.stop();
      await catalog.close();
    }
  }, 20_000);
});

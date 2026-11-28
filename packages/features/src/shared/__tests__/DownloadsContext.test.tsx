import type { CatalogService } from '@elv/data';
import {
  type DownloadManagerPort,
  type DownloadRecord,
  elvError,
  err,
  ok,
  type Result,
} from '@elv/domain';
import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import {
  type DownloadsContextValue,
  DownloadsProvider,
  hasManagedDownload,
  useDownloads,
} from '../DownloadsContext';

function makeRecord(overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'dl-1',
    profileId: 'profile-1',
    sourceId: 'src-1',
    itemKey: 'ep:src-1:42',
    kind: 'episode',
    title: 'Pilot',
    seriesTitle: 'Andor',
    season: 1,
    episodeNum: 1,
    poster: 'https://img.test/andor.jpg',
    localFileName: 'andor-s1e1.mp4',
    localUri: null,
    bytesDownloaded: 120_000_000,
    totalBytes: 500_000_000,
    status: 'paused',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function Harness({ onReady }: { onReady: (ctx: DownloadsContextValue) => void }) {
  const ctx = useDownloads();
  onReady(ctx);
  return <Text>{ctx.records.length}</Text>;
}

describe('DownloadsContext', () => {
  it('re-resolves stream URL and calls manager.enqueue when resume returns download-source-unavailable', async () => {
    const paused = makeRecord();
    const enqueue = jest.fn(async () => ok({ ...paused, status: 'queued' as const }));
    const resume = jest.fn(async () =>
      err(elvError('playback', 'download-source-unavailable', 'restart cleared stream URL')),
    );
    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => [paused]),
      get: jest.fn(async () => paused),
      enqueue,
      pause: jest.fn(async () => ok(undefined)),
      resume,
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: jest.fn(() => () => {}),
    };

    const resolveStream = jest.fn(async () =>
      ok({
        url: 'https://cdn.example/fresh-token/andor-s1e1.mp4',
        headers: { 'User-Agent': 'ELV/1.0' },
        sourceId: 'src-1',
        channelKey: paused.itemKey,
      }),
    );
    const catalog = { resolveStream } as unknown as CatalogService;

    const ctxBox: { current: DownloadsContextValue | null } = { current: null };
    await render(
      <DownloadsProvider manager={manager} catalog={catalog} profileId="profile-1">
        <Harness
          onReady={(ctx) => {
            ctxBox.current = ctx;
          }}
        />
      </DownloadsProvider>,
    );

    await waitFor(() => expect(ctxBox.current?.records).toHaveLength(1));

    let result: Result<void> | undefined;
    await act(async () => {
      result = await ctxBox.current?.resume(paused.itemKey);
    });

    expect(result).toEqual(ok(undefined));
    expect(resume).toHaveBeenCalledWith(paused.itemKey, 'profile-1');
    expect(resolveStream).toHaveBeenCalledWith(paused.itemKey);
    expect(enqueue).toHaveBeenCalledWith({
      profileId: 'profile-1',
      sourceId: 'src-1',
      itemKey: 'ep:src-1:42',
      kind: 'episode',
      title: 'Pilot',
      seriesTitle: 'Andor',
      season: 1,
      episodeNum: 1,
      poster: 'https://img.test/andor.jpg',
      streamUrl: 'https://cdn.example/fresh-token/andor-s1e1.mp4',
      headers: { 'User-Agent': 'ELV/1.0' },
    });
  });

  it('hasManagedDownload excludes undefined, canceled, and failed records', () => {
    expect(hasManagedDownload(undefined)).toBe(false);
    expect(hasManagedDownload(makeRecord({ status: 'canceled' }))).toBe(false);
    expect(hasManagedDownload(makeRecord({ status: 'failed' }))).toBe(false);
    expect(hasManagedDownload(makeRecord({ status: 'queued' }))).toBe(true);
    expect(hasManagedDownload(makeRecord({ status: 'downloading' }))).toBe(true);
    expect(hasManagedDownload(makeRecord({ status: 'paused' }))).toBe(true);
    expect(hasManagedDownload(makeRecord({ status: 'completed' }))).toBe(true);
  });

  it('calls manager.enqueueBatch directly without eagerly resolving streams when supported', async () => {
    const rec1 = makeRecord({
      itemKey: 'x:src-1:episode:101',
      seriesKey: 'x:src-1:series:7',
      status: 'queued',
    });
    const rec2 = makeRecord({
      itemKey: 'x:src-1:episode:102',
      seriesKey: 'x:src-1:series:7',
      status: 'queued',
    });
    const enqueueBatch = jest.fn(async () => ok([rec1, rec2] as readonly DownloadRecord[]));
    const enqueue = jest.fn(async () => ok(rec1));
    const resolveStream = jest.fn();

    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => []),
      get: jest.fn(async () => null),
      enqueue,
      enqueueBatch,
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: jest.fn(() => () => {}),
    };

    const catalog = { resolveStream } as unknown as CatalogService;
    const ctxBox: { current: DownloadsContextValue | null } = { current: null };
    await render(
      <DownloadsProvider manager={manager} catalog={catalog} profileId="profile-1">
        <Harness
          onReady={(ctx) => {
            ctxBox.current = ctx;
          }}
        />
      </DownloadsProvider>,
    );

    let result: Result<readonly DownloadRecord[]> | undefined;
    await act(async () => {
      result = await ctxBox.current?.enqueueBatch([
        {
          sourceId: 'src-1',
          itemKey: 'x:src-1:episode:101',
          kind: 'episode',
          title: 'Ep 1',
          seriesKey: 'x:src-1:series:7',
          seriesTitle: 'Andor',
          season: 1,
          episodeNum: 1,
        },
        {
          sourceId: 'src-1',
          itemKey: 'x:src-1:episode:102',
          kind: 'episode',
          title: 'Ep 2',
          seriesKey: 'x:src-1:series:7',
          seriesTitle: 'Andor',
          season: 1,
          episodeNum: 2,
        },
      ]);
    });

    expect(result?.ok).toBe(true);
    expect(resolveStream).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(enqueueBatch).toHaveBeenCalledTimes(1);
    expect(enqueueBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        profileId: 'profile-1',
        itemKey: 'x:src-1:episode:101',
        seriesKey: 'x:src-1:series:7',
      }),
      expect.objectContaining({
        profileId: 'profile-1',
        itemKey: 'x:src-1:episode:102',
        seriesKey: 'x:src-1:series:7',
      }),
    ]);
  });

  it('falls back to sequential enqueue loop when manager lacks enqueueBatch or rejects lazy URLs', async () => {
    const completed = makeRecord({
      itemKey: 'x:src-1:episode:201',
      status: 'completed',
      localUri: 'file:///downloads/e201.mp4',
    });
    const queued = makeRecord({ itemKey: 'x:src-1:episode:202', status: 'queued' });
    const enqueue = jest.fn(async () => ok(queued));
    const resolveStream = jest.fn(async (key: string) =>
      ok({
        url: `https://cdn.example/${key}.mp4`,
        headers: {},
        sourceId: 'src-1',
        channelKey: key,
      }),
    );

    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => [completed]),
      get: jest.fn(async () => null),
      enqueue,
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: jest.fn(() => () => {}),
    };
    const catalog = { resolveStream } as unknown as CatalogService;
    const ctxBox: { current: DownloadsContextValue | null } = { current: null };
    await render(
      <DownloadsProvider manager={manager} catalog={catalog} profileId="profile-1">
        <Harness
          onReady={(ctx) => {
            ctxBox.current = ctx;
          }}
        />
      </DownloadsProvider>,
    );
    await waitFor(() => expect(ctxBox.current?.records).toHaveLength(1));

    let res: Result<readonly DownloadRecord[]> | undefined;
    await act(async () => {
      res = await ctxBox.current?.enqueueBatch([
        {
          sourceId: 'src-1',
          itemKey: 'x:src-1:episode:201',
          kind: 'episode',
          title: 'Already Done',
        },
        {
          sourceId: 'src-1',
          itemKey: 'x:src-1:episode:202',
          kind: 'episode',
          title: 'New Episode',
        },
      ]);
    });

    expect(res?.ok).toBe(true);
    if (res?.ok) expect(res.value).toHaveLength(1);
    expect(resolveStream).toHaveBeenCalledTimes(1);
    expect(resolveStream).toHaveBeenCalledWith('x:src-1:episode:202');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('chunks large enqueueBatch calls at 500, falls back on invalid-download-url, and propagates queue-full errors', async () => {
    const enqueueBatch = jest.fn<Promise<Result<readonly DownloadRecord[]>>, [readonly unknown[]]>(
      async (chunk) =>
        ok(chunk.map((_, i) => makeRecord({ itemKey: `ep:${i}`, status: 'queued' }))),
    );
    const manager: DownloadManagerPort = {
      supported: true,
      list: jest.fn(async () => []),
      get: jest.fn(async () => null),
      enqueue: jest.fn(async (input) =>
        ok(makeRecord({ itemKey: input.itemKey, status: 'queued' })),
      ),
      enqueueBatch,
      pause: jest.fn(async () => ok(undefined)),
      resume: jest.fn(async () => ok(undefined)),
      cancel: jest.fn(async () => ok(undefined)),
      remove: jest.fn(async () => ok(undefined)),
      subscribe: jest.fn(() => () => {}),
    };

    const resolveStream = jest.fn(async (key: string) =>
      ok({
        url: `https://cdn.example/${key}.mp4`,
        headers: {},
        sourceId: 'src-1',
        channelKey: key,
      }),
    );
    const catalog = { resolveStream } as unknown as CatalogService;
    const ctxBox: { current: DownloadsContextValue | null } = { current: null };
    await render(
      <DownloadsProvider manager={manager} catalog={catalog} profileId="profile-1">
        <Harness
          onReady={(ctx) => {
            ctxBox.current = ctx;
          }}
        />
      </DownloadsProvider>,
    );

    const bigBatch = Array.from({ length: 505 }, (_, i) => ({
      sourceId: 'src-1',
      itemKey: `ep:${i}`,
      kind: 'episode' as const,
      title: `Episode ${i + 1}`,
    }));
    let chunkedRes: Result<readonly DownloadRecord[]> | undefined;
    await act(async () => {
      chunkedRes = await ctxBox.current?.enqueueBatch(bigBatch);
    });
    expect(chunkedRes?.ok).toBe(true);
    if (chunkedRes?.ok) expect(chunkedRes.value).toHaveLength(505);
    expect(enqueueBatch).toHaveBeenCalledTimes(2);
    expect(enqueueBatch.mock.calls[0]?.[0]).toHaveLength(500);
    expect(enqueueBatch.mock.calls[1]?.[0]).toHaveLength(5);

    // Fallback when manager.enqueueBatch rejects lazy URLs with invalid-download-url.
    enqueueBatch.mockResolvedValueOnce(err(elvError('playback', 'invalid-download-url')));
    let fallbackRes: Result<readonly DownloadRecord[]> | undefined;
    await act(async () => {
      fallbackRes = await ctxBox.current?.enqueueBatch([
        { sourceId: 'src-1', itemKey: 'ep:lazy-fb', kind: 'episode', title: 'Fallback Ep' },
      ]);
    });
    expect(fallbackRes?.ok).toBe(true);
    expect(resolveStream).toHaveBeenCalledWith('ep:lazy-fb');

    // Non-URL error (download-queue-full) propagates directly without falling back.
    enqueueBatch.mockResolvedValueOnce(err(elvError('storage', 'download-queue-full')));
    let fullRes: Result<readonly DownloadRecord[]> | undefined;
    await act(async () => {
      fullRes = await ctxBox.current?.enqueueBatch([
        { sourceId: 'src-1', itemKey: 'ep:full', kind: 'episode', title: 'Full Ep' },
      ]);
    });
    expect(fullRes?.ok).toBe(false);
    if (fullRes && !fullRes.ok) expect(fullRes.error.code).toBe('download-queue-full');
  });
});

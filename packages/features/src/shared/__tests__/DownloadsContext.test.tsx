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
});

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DOWNLOAD_EXTENSIONS,
  computeDownloadProgressRatio,
  type DownloadEnqueueInput,
  type DownloadManagerPort,
  type DownloadRecord,
  formatDownloadBytes,
  isActiveDownloadStatus,
  isDownloadMediaKind,
  isDownloadStatus,
  isPlayableDownload,
  isValidManagedDownloadFileName,
} from './downloads';
import { ok } from './result';

describe('downloads domain contracts and helpers', () => {
  it('exposes frozen allowlisted container extensions', () => {
    expect(Object.isFrozen(ALLOWED_DOWNLOAD_EXTENSIONS)).toBe(true);
    expect(ALLOWED_DOWNLOAD_EXTENSIONS).toEqual(['.mp4', '.mkv', '.ts', '.m4v', '.webm', '.mov']);
  });

  it('accepts strictly movie and episode media kinds', () => {
    expect(isDownloadMediaKind('movie')).toBe(true);
    expect(isDownloadMediaKind('episode')).toBe(true);
    expect(isDownloadMediaKind('live')).toBe(false);
    expect(isDownloadMediaKind('series')).toBe(false);
    expect(isDownloadMediaKind('')).toBe(false);
    expect(isDownloadMediaKind(null)).toBe(false);
    expect(isDownloadMediaKind(42)).toBe(false);
  });

  it('validates download statuses', () => {
    for (const status of ['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled']) {
      expect(isDownloadStatus(status)).toBe(true);
    }
    expect(isDownloadStatus('unknown')).toBe(false);
    expect(isDownloadStatus(null)).toBe(false);
  });

  it('validates managed download file names and rejects traversal, separators, and disallowed extensions', () => {
    expect(isValidManagedDownloadFileName('movie-123.mp4')).toBe(true);
    expect(isValidManagedDownloadFileName('ep_01.MKV')).toBe(true);
    expect(isValidManagedDownloadFileName('clip.ts')).toBe(true);
    expect(isValidManagedDownloadFileName('film.m4v')).toBe(true);
    expect(isValidManagedDownloadFileName('sample.webm')).toBe(true);
    expect(isValidManagedDownloadFileName('trailer.mov')).toBe(true);

    expect(isValidManagedDownloadFileName('')).toBe(false);
    expect(isValidManagedDownloadFileName('.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('.hidden.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName(' movie.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('movie.mp4 ')).toBe(false);
    expect(isValidManagedDownloadFileName('dir/movie.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('dir\\movie.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('../movie.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('a..b.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('movie.\u0000.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('movie\n.mp4')).toBe(false);
    expect(isValidManagedDownloadFileName('movie.exe')).toBe(false);
    expect(isValidManagedDownloadFileName('movie.m3u8')).toBe(false);
    expect(isValidManagedDownloadFileName('movie..mp4')).toBe(false);
    expect(isValidManagedDownloadFileName(`${'a'.repeat(200)}.mp4`)).toBe(false);
  });

  it('computes clamped progress ratios', () => {
    expect(computeDownloadProgressRatio(50, 100)).toBe(0.5);
    expect(computeDownloadProgressRatio(150, 100)).toBe(1);
    expect(computeDownloadProgressRatio(-10, 100)).toBe(0);
    expect(computeDownloadProgressRatio(Number.NaN, 100)).toBe(0);
    expect(computeDownloadProgressRatio(50, null)).toBeNull();
    expect(computeDownloadProgressRatio(50, undefined)).toBeNull();
    expect(computeDownloadProgressRatio(50, 0)).toBeNull();
    expect(computeDownloadProgressRatio(50, -5)).toBeNull();
  });

  it('formats byte sizes cleanly', () => {
    expect(formatDownloadBytes(0)).toBe('0 B');
    expect(formatDownloadBytes(-12)).toBe('0 B');
    expect(formatDownloadBytes(Number.NaN)).toBe('0 B');
    expect(formatDownloadBytes(512)).toBe('512 B');
    expect(formatDownloadBytes(1536)).toBe('1.5 KB');
    expect(formatDownloadBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatDownloadBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB');
  });

  it('identifies playable and active download states', () => {
    const base: DownloadRecord = {
      id: 'dl-1',
      profileId: 'default',
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie',
      title: 'Night Train',
      localFileName: 'dl-1.mp4',
      localUri: 'file:///downloads/dl-1.mp4',
      bytesDownloaded: 1000,
      totalBytes: 1000,
      status: 'completed',
      createdAt: 100,
      updatedAt: 200,
      completedAt: 200,
    };
    expect(isPlayableDownload(base)).toBe(true);
    expect(isPlayableDownload({ ...base, status: 'downloading' })).toBe(false);
    expect(isPlayableDownload({ ...base, localUri: null })).toBe(false);
    expect(isPlayableDownload({ ...base, localUri: '   ' })).toBe(false);
    expect(isPlayableDownload(null)).toBe(false);
    expect(isPlayableDownload(undefined)).toBe(false);

    expect(isActiveDownloadStatus('queued')).toBe(true);
    expect(isActiveDownloadStatus('downloading')).toBe(true);
    expect(isActiveDownloadStatus('paused')).toBe(true);
    expect(isActiveDownloadStatus('completed')).toBe(false);
    expect(isActiveDownloadStatus('failed')).toBe(false);
    expect(isActiveDownloadStatus('canceled')).toBe(false);
  });

  it('supports explicit seriesKey on DownloadRecord/DownloadEnqueueInput and optional enqueueBatch on DownloadManagerPort', async () => {
    const input: DownloadEnqueueInput = {
      sourceId: 's1',
      itemKey: 'x:s1:episode:555',
      kind: 'episode',
      title: 'Episode 1',
      seriesKey: 'x:s1:series:42',
      seriesTitle: 'Remake',
      season: 1,
      episodeNum: 1,
    };
    const record: DownloadRecord = {
      id: 'default::x:s1:episode:555',
      profileId: 'default',
      sourceId: input.sourceId,
      itemKey: input.itemKey,
      kind: input.kind,
      title: input.title,
      seriesKey: input.seriesKey ?? null,
      seriesTitle: input.seriesTitle ?? null,
      season: input.season ?? null,
      episodeNum: input.episodeNum ?? null,
      localFileName: 'ep-555.mp4',
      localUri: null,
      bytesDownloaded: 0,
      totalBytes: null,
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
    };
    const port: DownloadManagerPort = {
      supported: true,
      list: async () => [record],
      get: async () => record,
      enqueue: async () => ok(record),
      enqueueBatch: async (items) => ok(items.map(() => record)),
      pause: async () => ok(undefined),
      resume: async () => ok(undefined),
      cancel: async () => ok(undefined),
      remove: async () => ok(undefined),
      subscribe: () => () => undefined,
    };
    const res = await port.enqueueBatch?.([input]);
    expect(res?.ok).toBe(true);
    if (res?.ok) {
      expect(res.value[0]?.seriesKey).toBe('x:s1:series:42');
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpSqliteDriver } from '../storage';

const xmltvNative = vi.hoisted(() => ({
  isNativeXmltvStagerAvailable: vi.fn(() => true),
  stageXmltv: vi.fn(),
  cancelXmltvStage: vi.fn(),
  cleanupStageFile: vi.fn(),
}));
vi.mock('@elv/xmltv-native', () => xmltvNative);

import { createDeviceNativeGuideStager } from './native-guide-stager';

function makeDriver(): OpSqliteDriver & {
  getDbPath: ReturnType<typeof vi.fn>;
  attachAndCopyProgrammes: ReturnType<typeof vi.fn>;
} {
  return {
    exec: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ changes: 0 })),
    all: vi.fn(async () => []),
    batch: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn) => fn(makeDriver())),
    setAbortSignal: vi.fn(),
    getDbPath: vi.fn(() => '/data/data/app/databases/catalog.db'),
    attachAndCopyProgrammes: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

const REQ = {
  jobId: 'src-1:3:override:0',
  url: 'https://guide.example/epg.xml.gz',
  sourceId: 'src-1',
  runId: 3,
  fromMs: 100,
  toMs: 200,
  ifNoneMatch: '"v1"',
};

beforeEach(() => {
  xmltvNative.isNativeXmltvStagerAvailable.mockReset().mockReturnValue(true);
  xmltvNative.stageXmltv.mockReset();
  xmltvNative.cancelXmltvStage.mockReset();
  xmltvNative.cleanupStageFile.mockReset();
});

describe('createDeviceNativeGuideStager', () => {
  it('returns undefined when @elv/xmltv-native is unavailable', () => {
    xmltvNative.isNativeXmltvStagerAvailable.mockReturnValue(false);
    expect(createDeviceNativeGuideStager(makeDriver())).toBeUndefined();
  });

  it('stages outside attachAndCopyProgrammes, copies via op-sqlite, strips stageDbPath, and cleans up temp file', async () => {
    const db = makeDriver();
    const order: string[] = [];
    const stageDbPath = '/data/data/app/databases/catalog.db.xmltv-stage-src-1_3_override_0.db';
    xmltvNative.stageXmltv.mockImplementation(async () => {
      order.push('stageXmltv');
      expect(db.attachAndCopyProgrammes).not.toHaveBeenCalled();
      return {
        kind: 'staged',
        stageDbPath,
        channels: [{ id: 'c1', names: ['News'] }],
        stagedCounts: { c1: 5 },
        seenProgrammes: 5,
        stagedProgrammes: 5,
        warnings: 0,
        warningCodes: [],
        etag: '"v2"',
      };
    });
    db.attachAndCopyProgrammes.mockImplementation(async () => {
      order.push('attachAndCopyProgrammes');
    });
    xmltvNative.cleanupStageFile.mockImplementation(() => {
      order.push('cleanupStageFile');
    });

    const stager = createDeviceNativeGuideStager(db);
    expect(stager).toBeDefined();
    const res = await stager?.stage(REQ);

    expect(order).toEqual(['stageXmltv', 'attachAndCopyProgrammes', 'cleanupStageFile']);
    expect(db.attachAndCopyProgrammes).toHaveBeenCalledWith(stageDbPath);
    expect(xmltvNative.cleanupStageFile).toHaveBeenCalledWith(stageDbPath);
    expect(res).toEqual({
      kind: 'staged',
      channels: [{ id: 'c1', names: ['News'] }],
      stagedCounts: { c1: 5 },
      seenProgrammes: 5,
      stagedProgrammes: 5,
      warnings: 0,
      warningCodes: [],
      etag: '"v2"',
    });
    expect(res && 'stageDbPath' in res).toBe(false);
  });

  it('always cleans up temp stage file when attachAndCopyProgrammes throws', async () => {
    const db = makeDriver();
    const stageDbPath = '/data/data/app/databases/catalog.db.xmltv-stage-job.db';
    xmltvNative.stageXmltv.mockResolvedValue({
      kind: 'staged',
      stageDbPath,
      channels: [],
      stagedCounts: {},
      seenProgrammes: 1,
      stagedProgrammes: 1,
      warnings: 0,
      warningCodes: [],
    });
    db.attachAndCopyProgrammes.mockRejectedValue(new Error('storage/sql-failed'));

    const stager = createDeviceNativeGuideStager(db);
    await expect(stager?.stage(REQ)).rejects.toThrow('storage/sql-failed');
    expect(xmltvNative.cleanupStageFile).toHaveBeenCalledWith(stageDbPath);
  });

  it('does not touch attachAndCopyProgrammes or cleanupStageFile on not-modified or http-error', async () => {
    const db = makeDriver();
    xmltvNative.stageXmltv.mockResolvedValueOnce({ kind: 'not-modified', etag: '"v1"' });
    const stager = createDeviceNativeGuideStager(db);
    expect(await stager?.stage(REQ)).toEqual({ kind: 'not-modified', etag: '"v1"' });
    expect(db.attachAndCopyProgrammes).not.toHaveBeenCalled();
    expect(xmltvNative.cleanupStageFile).not.toHaveBeenCalled();

    xmltvNative.stageXmltv.mockResolvedValueOnce({
      kind: 'http-error',
      status: 503,
      retryable: true,
      code: 'http-503',
    });
    expect(await stager?.stage(REQ)).toEqual({
      kind: 'http-error',
      status: 503,
      retryable: true,
      code: 'http-503',
    });
    expect(db.attachAndCopyProgrammes).not.toHaveBeenCalled();
    expect(xmltvNative.cleanupStageFile).not.toHaveBeenCalled();

    stager?.cancel?.('job-42');
    expect(xmltvNative.cancelXmltvStage).toHaveBeenCalledWith('job-42');
  });
});

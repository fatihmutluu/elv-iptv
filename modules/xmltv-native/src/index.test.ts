import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeXmltvStageRequest } from './index';

const platformState = { OS: 'android' as string };
const requireOptionalNativeModule = vi.fn();

vi.mock('expo-modules-core', () => ({
  get Platform() {
    return platformState;
  },
  requireOptionalNativeModule,
}));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

const SAMPLE_REQUEST: NativeXmltvStageRequest = {
  jobId: 'job-1',
  url: 'https://guide.example/epg.xml.gz',
  dbPath: '/data/data/app/databases/catalog.db',
  sourceId: 'src-1',
  runId: 7,
  fromMs: 1_700_000_000_000,
  toMs: 1_700_604_800_000,
  headers: { 'user-agent': 'ELV/1.0' },
  ifNoneMatch: '"v1"',
  ifModifiedSince: 'Wed, 21 Oct 2026 07:28:00 GMT',
  defaultTimeZone: 'Europe/Istanbul',
  timeoutMs: 180_000,
};

afterEach(() => {
  platformState.OS = 'android';
  requireOptionalNativeModule.mockReset();
});

describe('@elv/xmltv-native JS bridge', () => {
  it('returns null and no-ops cleanly on web', async () => {
    platformState.OS = 'web';
    requireOptionalNativeModule.mockReturnValue({
      stageXmltv: vi.fn(),
      cancelXmltvStage: vi.fn(),
    });
    const mod = await loadModule();

    expect(mod.isNativeXmltvStagerAvailable()).toBe(false);
    await expect(mod.stageXmltv(SAMPLE_REQUEST)).resolves.toBeNull();
    expect(() => mod.cancelXmltvStage('job-1')).not.toThrow();
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns null and no-ops cleanly when native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const mod = await loadModule();

    expect(mod.isNativeXmltvStagerAvailable()).toBe(false);
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvXmltvNative');
    await expect(mod.stageXmltv(SAMPLE_REQUEST)).resolves.toBeNull();
    expect(() => mod.cancelXmltvStage('job-1')).not.toThrow();
  });

  it('forwards stageXmltv staged results and cancelXmltvStage to native', async () => {
    const stageXmltv = vi.fn(async () => ({
      kind: 'staged',
      channels: [
        { id: 'ch1', names: ['News HD', 'News'], icon: 'https://cdn.example/ch1.png', lcn: '101' },
        { id: 'ch2', names: ['Sports'], icon: '', lcn: '' },
      ],
      stagedCounts: { ch1: 12, ch2: 8 },
      seenProgrammes: 25,
      stagedProgrammes: 20,
      warnings: 1,
      warningCodes: ['programme-bad-time'],
      etag: '"v2"',
      lastModified: '',
    }));
    const cancelXmltvStage = vi.fn();
    requireOptionalNativeModule.mockReturnValue({ stageXmltv, cancelXmltvStage });
    const mod = await loadModule();

    expect(mod.isNativeXmltvStagerAvailable()).toBe(true);
    const res = await mod.stageXmltv(SAMPLE_REQUEST);
    expect(stageXmltv).toHaveBeenCalledWith(SAMPLE_REQUEST);
    expect(res).toEqual({
      kind: 'staged',
      channels: [
        { id: 'ch1', names: ['News HD', 'News'], icon: 'https://cdn.example/ch1.png', lcn: '101' },
        { id: 'ch2', names: ['Sports'] },
      ],
      stagedCounts: { ch1: 12, ch2: 8 },
      seenProgrammes: 25,
      stagedProgrammes: 20,
      warnings: 1,
      warningCodes: ['programme-bad-time'],
      etag: '"v2"',
    });

    mod.cancelXmltvStage('job-1');
    expect(cancelXmltvStage).toHaveBeenCalledWith('job-1');
  });

  it('normalizes not-modified and http-error native responses without leaking URLs', async () => {
    const stageXmltv = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'not-modified',
        etag: '"v1"',
        lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
      })
      .mockResolvedValueOnce({
        kind: 'http-error',
        status: 503,
        retryable: true,
        code: 'http-503',
      });
    const cancelXmltvStage = vi.fn();
    requireOptionalNativeModule.mockReturnValue({ stageXmltv, cancelXmltvStage });
    const mod = await loadModule();

    await expect(mod.stageXmltv(SAMPLE_REQUEST)).resolves.toEqual({
      kind: 'not-modified',
      etag: '"v1"',
      lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
    await expect(mod.stageXmltv(SAMPLE_REQUEST)).resolves.toEqual({
      kind: 'http-error',
      status: 503,
      retryable: true,
      code: 'http-503',
    });
  });

  it('omits optional request keys when undefined', async () => {
    const stageXmltv = vi.fn(async () => ({
      kind: 'not-modified',
    }));
    requireOptionalNativeModule.mockReturnValue({
      stageXmltv,
      cancelXmltvStage: vi.fn(),
    });
    const mod = await loadModule();

    await mod.stageXmltv({
      jobId: 'job-2',
      url: 'https://guide.example/min.xml',
      dbPath: '/tmp/catalog.db',
      sourceId: 'src-2',
      runId: 1,
      fromMs: 0,
      toMs: 1_000,
    });
    expect(stageXmltv).toHaveBeenCalledWith({
      jobId: 'job-2',
      url: 'https://guide.example/min.xml',
      dbPath: '/tmp/catalog.db',
      sourceId: 'src-2',
      runId: 1,
      fromMs: 0,
      toMs: 1_000,
    });
  });
});

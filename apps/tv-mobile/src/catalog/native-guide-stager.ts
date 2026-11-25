import type { NativeGuideStageResult, NativeGuideStager } from '@elv/data';
import {
  cancelXmltvStage,
  cleanupStageFile,
  isNativeXmltvStagerAvailable,
  stageXmltv,
} from '@elv/xmltv-native';
import type { OpSqliteDriver } from '../storage';

/**
 * Builds the mobile/TV {@link NativeGuideStager} backed by `@elv/xmltv-native` (`#478`).
 *
 * Streams and parses XMLTV into a brand-new temp SQLite file completely outside `op-sqlite`'s
 * writer queue (so app writes never block during HTTP download/parse, and OS `libsqlite3` never
 * touches `catalog.db`'s WAL/SHM locks). When staging succeeds, `op-sqlite`'s own writer
 * connection `ATTACH`es the temp file, copies `programmes_next`, `DETACH`es, and deletes the temp
 * file in `finally`.
 */
export function createDeviceNativeGuideStager(db: OpSqliteDriver): NativeGuideStager | undefined {
  if (!isNativeXmltvStagerAvailable()) return undefined;
  return {
    async stage(req): Promise<NativeGuideStageResult> {
      const res = await stageXmltv({
        jobId: req.jobId,
        url: req.url,
        dbPath: db.getDbPath(),
        sourceId: req.sourceId,
        runId: req.runId,
        fromMs: req.fromMs,
        toMs: req.toMs,
        ...(req.headers === undefined ? {} : { headers: req.headers }),
        ...(req.ifNoneMatch === undefined ? {} : { ifNoneMatch: req.ifNoneMatch }),
        ...(req.ifModifiedSince === undefined ? {} : { ifModifiedSince: req.ifModifiedSince }),
        ...(req.defaultTimeZone === undefined ? {} : { defaultTimeZone: req.defaultTimeZone }),
        ...(req.timeoutMs === undefined ? {} : { timeoutMs: req.timeoutMs }),
      });
      if (res === null) {
        return { kind: 'http-error', status: 0, retryable: false, code: 'unavailable' };
      }
      if (res.kind !== 'staged') {
        return res;
      }
      const { stageDbPath } = res;
      if (stageDbPath === undefined || stageDbPath.length === 0) {
        if (res.stagedProgrammes > 0) {
          return {
            kind: 'http-error',
            status: 0,
            retryable: false,
            code: 'native-missing-stage-db',
          };
        }
      } else {
        try {
          await db.attachAndCopyProgrammes(stageDbPath);
        } finally {
          try {
            cleanupStageFile(stageDbPath);
          } catch {
            // Best-effort cleanup of temp stage file.
          }
        }
      }
      return {
        kind: 'staged',
        channels: res.channels,
        stagedCounts: res.stagedCounts,
        seenProgrammes: res.seenProgrammes,
        stagedProgrammes: res.stagedProgrammes,
        warnings: res.warnings,
        warningCodes: res.warningCodes,
        ...(res.etag === undefined ? {} : { etag: res.etag }),
        ...(res.lastModified === undefined ? {} : { lastModified: res.lastModified }),
      };
    },
    cancel(jobId) {
      cancelXmltvStage(jobId);
    },
  };
}

import { isTelemetryRecordRequest, type TelemetryRecordRequest } from '../../shared/sync-ipc.ts';

/** Private control and secret-bridging messages from Electron `main` to the catalog `utilityProcess`. */
export type MainToWorkerMessage =
  | { type: 'init'; dbPath: string }
  | { type: 'client-port'; clientId: number }
  | { type: 'client-disconnect'; clientId: number }
  | { type: 'secret-reply'; reqId: number; ok: true; value: string | null }
  | { type: 'secret-reply'; reqId: number; ok: false; message: string }
  | { type: 'shutdown' };

/** Private lifecycle and secret-request messages from the catalog `utilityProcess` to Electron `main`. */
export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'secret-request'; reqId: number; op: 'get' | 'delete'; key: string }
  | { type: 'secret-request'; reqId: number; op: 'set'; key: string; value: string }
  | { type: 'telemetry'; event: TelemetryRecordRequest }
  | { type: 'shutdown-complete' };

/** Maximum characters allowed in a `secret-request` `set` payload (2x `@elv/data`'s 64 KiB `urlvars` cap). */
export const MAX_SECRET_VALUE_CHARS = 131_072;

/** Allowed character pattern for `SecretStore` keys across main and utility processes. */
export const SECRET_KEY_RE = /^[A-Za-z0-9._-]{1,256}$/;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isPositiveId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) > 0;

/** Validates a message arriving on `process.parentPort` inside the catalog utility process. */
export function isMainToWorkerMessage(x: unknown): x is MainToWorkerMessage {
  if (!isRecord(x)) return false;
  switch (x['type']) {
    case 'init':
      return (
        typeof x['dbPath'] === 'string' && x['dbPath'].length > 0 && x['dbPath'].length <= 4096
      );
    case 'client-port':
    case 'client-disconnect':
      return isPositiveId(x['clientId']);
    case 'secret-reply':
      if (!isPositiveId(x['reqId']) || typeof x['ok'] !== 'boolean') return false;
      return x['ok']
        ? x['value'] === null || typeof x['value'] === 'string'
        : typeof x['message'] === 'string';
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

/** Validates a message arriving on `UtilityProcess.on('message')` in the Electron main process. */
export function isWorkerToMainMessage(x: unknown): x is WorkerToMainMessage {
  if (!isRecord(x)) return false;
  switch (x['type']) {
    case 'ready':
    case 'shutdown-complete':
      return true;
    case 'secret-request': {
      if (!isPositiveId(x['reqId'])) return false;
      if (typeof x['key'] !== 'string' || !SECRET_KEY_RE.test(x['key'])) return false;
      if (x['op'] === 'get' || x['op'] === 'delete') return true;
      if (x['op'] === 'set') {
        return typeof x['value'] === 'string' && x['value'].length <= MAX_SECRET_VALUE_CHARS;
      }
      return false;
    }
    case 'telemetry':
      return isTelemetryRecordRequest(x['event']);
    default:
      return false;
  }
}

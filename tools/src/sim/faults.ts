import { type Readable, Transform } from 'node:stream';

/** One injected failure, parsed from a fault spec such as `status=403,drop@10s`. */
export type Fault =
  | { kind: 'status'; code: number }
  | { kind: 'drop'; atSec: number }
  | { kind: 'stall'; forSec: number; atSec: number }
  | { kind: 'slow-start'; sec: number }
  | { kind: 'redirect' }
  | { kind: 'text-notice' }
  | { kind: 'rate'; kbps: number };

/** Thrown for a fault spec part that is unknown or malformed. */
export class FaultParseError extends Error {}

const NUM = '(\\d+(?:\\.\\d+)?)';
const STATUS = /^status=(\d{3})$/;
const DROP = new RegExp(`^drop@${NUM}s$`);
const STALL = new RegExp(`^stall${NUM}s@${NUM}s$`);
const SLOW = new RegExp(`^slow-start=${NUM}$`);
const RATE = /^rate=(\d+)$/;

function parsePart(part: string): Fault {
  if (part === 'redirect') return { kind: 'redirect' };
  if (part === 'text-notice') return { kind: 'text-notice' };
  const status = STATUS.exec(part);
  if (status) {
    const code = Number(status[1]);
    if (code >= 200 && code <= 599) return { kind: 'status', code };
  }
  const drop = DROP.exec(part);
  if (drop) return { kind: 'drop', atSec: Number(drop[1]) };
  const stall = STALL.exec(part);
  if (stall) return { kind: 'stall', forSec: Number(stall[1]), atSec: Number(stall[2]) };
  const slow = SLOW.exec(part);
  if (slow) return { kind: 'slow-start', sec: Number(slow[1]) };
  const rate = RATE.exec(part);
  if (rate && Number(rate[1]) > 0) return { kind: 'rate', kbps: Number(rate[1]) };
  throw new FaultParseError(`unknown or malformed fault "${part}"`);
}

/** Parses `status=403,drop@10s`; throws `FaultParseError` naming the bad part. */
export function parseFaults(spec: string): Fault[] {
  if (spec === '') return [];
  return spec.split(',').map(parsePart);
}

/**
 * Wraps a media stream with drop, stall and rate faults, timed from the first byte.
 * `drop` destroys the result with an error, `stall` pauses delivery once, `rate` paces output in kbit/s.
 */
export function applyStreamFaults(
  source: Readable,
  faults: readonly Fault[],
  clock: () => number = Date.now,
): Readable {
  const drop = faults.find((f) => f.kind === 'drop');
  const stall = faults.find((f) => f.kind === 'stall');
  const rate = faults.find((f) => f.kind === 'rate');
  if (!drop && !stall && !rate) return source;
  const timers = new Set<NodeJS.Timeout>();
  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });
  const bytesPerSec = rate ? (rate.kbps * 1000) / 8 : 0;
  const slice = Math.max(1, Math.floor(bytesPerSec / 10));
  let first: number | null = null;
  let sent = 0;
  let stalled = false;
  const out = new Transform({
    highWaterMark: 1024,
    transform(chunk: Buffer, _enc, done) {
      const run = async (): Promise<void> => {
        if (first === null) {
          first = clock();
          if (drop) {
            const timer = setTimeout(
              () => out.destroy(new Error('fault: connection dropped')),
              drop.atSec * 1000,
            );
            timers.add(timer);
          }
        }
        if (stall && !stalled && (clock() - first) / 1000 >= stall.atSec) {
          stalled = true;
          await pause(stall.forSec * 1000);
        }
        if (!rate) {
          this.push(chunk);
          return;
        }
        for (let at = 0; at < chunk.length; at += slice) {
          const part = chunk.subarray(at, at + slice);
          this.push(part);
          sent += part.length;
          const wait = (sent / bytesPerSec) * 1000 - (clock() - first);
          if (wait > 0) await pause(wait);
        }
      };
      run().then(() => done(), done);
    },
    destroy(error, callback) {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      source.destroy();
      callback(error);
    },
  });
  source.on('error', (error) => out.destroy(error));
  source.pipe(out);
  return out;
}

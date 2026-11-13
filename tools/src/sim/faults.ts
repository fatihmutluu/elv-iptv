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
    if (code >= 100 && code <= 599) return { kind: 'status', code };
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

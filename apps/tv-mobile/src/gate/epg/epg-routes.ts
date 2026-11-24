/** Parameters of the EPG proof gate deep link `elviptv://gate/epg?channels=1000&days=7&moves=220&auto=1`. */
export interface EpgGateParams {
  /** Number of synthetic channels (10..5,000; default 1,000). */
  readonly channels: number;
  /** Number of guide days per channel (1..14; default 7). */
  readonly days: number;
  /** Number of scripted vertical+horizontal navigation steps (10..1,000; default 220). */
  readonly moves: number;
  /** Whether the screen auto-drives scripted D-pad navigation and prints `ELV_GATE` (default true). */
  readonly auto: boolean;
}

const EPG_GATE_URL = /^elviptv:\/\/gate\/epg\/?(?:\?([^#]*))?(?:#.*)?$/;

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Math.min(Math.max(Number.parseInt(value, 10), min), max);
}

/**
 * Parses an EPG proof gate deep link (`elviptv://gate/epg`). Returns `undefined` for non-matching URLs.
 */
export function parseEpgGateUrl(url: string | null): EpgGateParams | undefined {
  if (url === null) return undefined;
  const match = EPG_GATE_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return {
    channels: readInt(query.get('channels'), 1000, 10, 5000),
    days: readInt(query.get('days'), 7, 1, 14),
    moves: readInt(query.get('moves'), 220, 10, 1000),
    auto: query.get('auto') !== '0',
  };
}

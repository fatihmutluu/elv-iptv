/** Parameters of the gate deep link `elviptv://gate/list?items=…&auto=1&rate=20&moves=600`. */
export interface GateParams {
  /** Number of synthetic list items, 1 to 1,000,000. */
  items: number;
  /** Whether the screen drives itself and prints the `ELV_GATE` line when done. */
  auto: boolean;
  /** Auto-driver events per second, 1 to 60. */
  rate: number;
  /** Number of scripted moves, 1 to 10,000. */
  moves: number;
}

const GATE_URL = /^elviptv:\/\/gate\/list\/?(?:\?([^#]*))?(?:#.*)?$/;

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  return Math.min(Math.max(Number.parseInt(value, 10), min), max);
}

/**
 * Parses a gate deep link. Returns `undefined` for anything that is not `elviptv://gate/list`. Missing or malformed
 * values fall back to the defaults (100,000 items, manual, 20 per second, 600 moves); numbers are clamped.
 */
export function parseGateUrl(url: string | null): GateParams | undefined {
  if (url === null) return undefined;
  const match = GATE_URL.exec(url);
  if (match === null) return undefined;
  const query = new Map<string, string>();
  for (const pair of (match[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0) query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return {
    items: readInt(query.get('items'), 100_000, 1, 1_000_000),
    auto: query.get('auto') === '1',
    rate: readInt(query.get('rate'), 20, 1, 60),
    moves: readInt(query.get('moves'), 600, 1, 10_000),
  };
}

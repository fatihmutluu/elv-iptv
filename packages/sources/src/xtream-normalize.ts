import { decodeEntities } from './entities';

const LOOSE_NUMBER_RE =
  /^([+-]?\d+(?:[.,]\d+)?)\s*(?:\/\s*\d+(?:[.,]\d+)?|%|mins?\b|minutes?\b|m\b|secs?\b|seconds?\b|s\b|hrs?\b|hours?\b)$/i;
const STRICT_INT_RE = /^\d+$/;

/**
 * Reads a finite number from a number, numeric string, or formatted rating/duration string
 * (`"7.8/10"`, `"8,5 / 10"`, `"45 min"`, `"5400s"`). Empty, null, NaN and junk are absent.
 */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  const match = LOOSE_NUMBER_RE.exec(trimmed);
  if (match?.[1] !== undefined) {
    const parsed = Number(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Reads a strict non-negative safe integer ID (`12`, `"12"`); floats, negatives, and units are rejected. */
export function toStrictInt(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  }
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!STRICT_INT_RE.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Reads trimmed, entity-decoded text from a string or number; empty and null are absent. */
export function toText(v: unknown): string | undefined {
  let raw: string;
  if (typeof v === 'string') raw = v;
  else if (typeof v === 'number' && Number.isFinite(v)) raw = String(v);
  else return undefined;
  const text = decodeEntities(raw).trim();
  return text === '' ? undefined : text;
}

/**
 * Merges records with a repeated id: the first record wins, `categoryIds` become the union in
 * first-seen order, and the order of first appearance is kept.
 */
export function mergeById<T extends { id: number; categoryIds: string[] }>(items: T[]): T[] {
  const byId = new Map<number, T>();
  for (const item of items) {
    const seen = byId.get(item.id);
    if (seen === undefined) {
      byId.set(item.id, { ...item, categoryIds: [...item.categoryIds] });
      continue;
    }
    for (const id of item.categoryIds) {
      if (!seen.categoryIds.includes(id)) seen.categoryIds.push(id);
    }
  }
  return [...byId.values()];
}

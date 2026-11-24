import { elvError, err, ok, type Result } from './result';

/** Per-source DNS address-family preference (`#172`). */
export type DnsFamilyPreference = 'system' | 'ipv4' | 'ipv6';

const DNS_FAMILIES: ReadonlySet<string> = new Set(['system', 'ipv4', 'ipv6']);
const IPV4_PART_RE = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/** Returns a normalized {@link DnsFamilyPreference} or `undefined` when invalid/unset. */
export function normalizeDnsFamily(raw: unknown): DnsFamilyPreference | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  return DNS_FAMILIES.has(lower) ? (lower as DnsFamilyPreference) : undefined;
}

/** Strict syntactic IPv4 literal check (`0.0.0.0` – `255.255.255.255`, no leading zeros or ports). */
export function isValidIpv4Literal(raw: string): boolean {
  if (raw.length < 7 || raw.length > 15) return false;
  const parts = raw.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!IPV4_PART_RE.test(part)) return false;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Strict syntactic IPv6 literal check supporting compressed `::` and IPv4-mapped tails
 * (rejects zone IDs `%eth0`, ports, schemes, spaces, and control characters).
 */
export function isValidIpv6Literal(raw: string): boolean {
  if (raw.length < 2 || raw.length > 45) return false;
  if (!raw.includes(':')) return false;
  if (raw.includes('%') || raw.includes('/') || raw.includes(' ')) return false;
  const dblIdx = raw.indexOf('::');
  if (dblIdx >= 0 && raw.indexOf('::', dblIdx + 2) >= 0) return false;

  const parseSide = (segment: string, allowIpv4Tail: boolean): number | null => {
    if (segment === '') return 0;
    const parts = segment.split(':');
    let groups = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      if (part === '') return null;
      if (allowIpv4Tail && i === parts.length - 1 && part.includes('.')) {
        if (!isValidIpv4Literal(part)) return null;
        groups += 2;
      } else if (HEX_GROUP_RE.test(part)) {
        groups += 1;
      } else {
        return null;
      }
    }
    return groups;
  };

  if (dblIdx >= 0) {
    const left = parseSide(raw.slice(0, dblIdx), false);
    const right = parseSide(raw.slice(dblIdx + 2), true);
    if (left === null || right === null) return false;
    return left + right <= 7;
  }
  return parseSide(raw, true) === 8;
}

/**
 * Validates and normalizes an optional per-source literal IP host override (`#172`).
 * - Empty / whitespace / `undefined` -> `ok(undefined)` (no override).
 * - Valid IPv4 or IPv6 literal (with optional `[...]` brackets for IPv6) -> `ok(normalizedIp)` (lowercase, unbracketed).
 * - Hostnames, schemes, paths, ports, zone IDs, or control chars -> `err('source-format' / 'invalid-host-override')`.
 */
export function validateHostOverride(raw: unknown): Result<string | undefined> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-host-override'));
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return err(elvError('source-format', 'invalid-host-override'));
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return ok(undefined);
  if (isValidIpv4Literal(trimmed)) return ok(trimmed);

  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (isValidIpv6Literal(unbracketed)) return ok(unbracketed.toLowerCase());

  return err(elvError('source-format', 'invalid-host-override'));
}

/** Returns `4` for IPv4 literals, `6` for IPv6 literals, or `undefined` if not a valid IP literal. */
export function ipLiteralFamily(ip: string): 4 | 6 | undefined {
  if (isValidIpv4Literal(ip)) return 4;
  if (isValidIpv6Literal(ip)) return 6;
  return undefined;
}

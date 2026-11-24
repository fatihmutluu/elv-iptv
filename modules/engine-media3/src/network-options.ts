import type { LoadCommand } from '@elv/playback';

/** Per-source DNS address-family preference forwarded to Media3 (`#172`). */
type Media3DnsFamilyPreference = 'system' | 'ipv4' | 'ipv6';

/** Validated network transport options extracted from a `LoadCommand` (`#172`). */
export interface Media3NetworkLoadOptions {
  readonly dnsFamily?: Media3DnsFamilyPreference;
  readonly hostOverride?: string;
}

const DNS_FAMILIES: ReadonlySet<string> = new Set(['system', 'ipv4', 'ipv6']);
const IPV4_PART_RE = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/** Normalizes a DNS IP-family wire string, returning `undefined` when invalid or unset. */
export function normalizeMedia3DnsFamily(raw: unknown): Media3DnsFamilyPreference | undefined {
  if (typeof raw !== 'string') return undefined;
  const lower = raw.trim().toLowerCase();
  return DNS_FAMILIES.has(lower) ? (lower as Media3DnsFamilyPreference) : undefined;
}

function isValidIpv4Literal(raw: string): boolean {
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

function isValidIpv6Literal(raw: string): boolean {
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
 * Validates and normalizes an optional literal IPv4 or IPv6 host override (`#172`).
 * Strips optional IPv6 `[...]` brackets, lowercases IPv6 hex digits, and rejects hostnames,
 * ports, schemes, paths, zone IDs, and control characters.
 */
export function normalizeMedia3HostOverride(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (isValidIpv4Literal(trimmed)) return trimmed;
  const unbracketed =
    trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (isValidIpv6Literal(unbracketed)) return unbracketed.toLowerCase();
  return undefined;
}

/** Extracts and validates optional `dnsFamily` and `hostOverride` from a `LoadCommand` (`#172`). */
export function extractMedia3NetworkLoadOptions(cmd: LoadCommand): Media3NetworkLoadOptions {
  const opts = cmd.options as { dnsFamily?: unknown; hostOverride?: unknown } | undefined;
  const req = cmd as { dnsFamily?: unknown; hostOverride?: unknown };
  const dnsFamily = normalizeMedia3DnsFamily(opts?.dnsFamily ?? req.dnsFamily);
  const hostOverride = normalizeMedia3HostOverride(opts?.hostOverride ?? req.hostOverride);
  return {
    ...(dnsFamily === undefined ? {} : { dnsFamily }),
    ...(hostOverride === undefined ? {} : { hostOverride }),
  };
}

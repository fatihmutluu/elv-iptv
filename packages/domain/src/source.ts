import { sanitizeHeaderValue } from './headers';
import type { DnsFamilyPreference } from './network-transport';
import { elvError, err, ok, type Result } from './result';

/** Kinds of playlist source a user can add. */
export type SourceKind = 'm3u' | 'xtream' | 'stalker';

const MAC_HEX_PAIR_RE = /^[0-9a-fA-F]{2}$/;

/**
 * Validates and normalizes a Stalker/Ministra portal MAC address (`#29`).
 * Accepts `:` or `-` separators (6 hex octets) and returns uppercase `AA:BB:CC:DD:EE:FF`.
 */
export function normalizeMacAddress(raw: unknown): Result<string> {
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-mac'));
  }
  const trimmed = raw.trim();
  if (trimmed.length !== 17) {
    return err(elvError('source-format', 'invalid-mac'));
  }
  const sep = trimmed[2];
  if (sep !== ':' && sep !== '-') {
    return err(elvError('source-format', 'invalid-mac'));
  }
  const parts = trimmed.split(sep);
  if (parts.length !== 6 || !parts.every((p) => MAC_HEX_PAIR_RE.test(p))) {
    return err(elvError('source-format', 'invalid-mac'));
  }
  return ok(parts.map((p) => p.toUpperCase()).join(':'));
}

/** Returns `true` when `raw` is a valid 6-octet MAC address (`AA:BB:CC:DD:EE:FF`). */
export function isValidMacAddress(raw: unknown): boolean {
  return normalizeMacAddress(raw).ok;
}

/** Kinds of playable content. */
export type ContentKind = 'live' | 'movie' | 'series' | 'episode';

/** Per-source transport options. */
export interface TransportSettings {
  userAgent?: string;
  referer?: string;
  xtreamFormat?: 'ts' | 'm3u8';
  /** Opt-in support for legacy TLS (TLS 1.0/1.1 or older ciphers) for this source only (`#182`). */
  readonly allowLegacyTls?: boolean;
  /** Optional per-source DNS IP family preference (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Optional validated literal IPv4/IPv6 host override scoped strictly to the source origin while keeping TLS SNI (`#172`). */
  readonly hostOverride?: string;
}

/** Request headers (lower-case names) for a source's transport settings. */
export function transportHeaders(t: TransportSettings | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (t?.userAgent !== undefined) {
    const ua = sanitizeHeaderValue(t.userAgent);
    if (ua.length > 0) headers['user-agent'] = ua;
  }
  if (t?.referer !== undefined) {
    const ref = sanitizeHeaderValue(t.referer);
    if (ref.length > 0) headers.referer = ref;
  }
  return headers;
}

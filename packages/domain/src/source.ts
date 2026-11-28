import { sanitizeHeaderValue } from './headers';
import type { DnsFamilyPreference } from './network-transport';
import { elvError, err, ok, type Result } from './result';

/** Kinds of playlist source a user can add. */
export type SourceKind = 'm3u' | 'xtream' | 'stalker';

const MAC_BARE_12_RE = /^[0-9a-fA-F]{12}$/;
const MAC_PAIR_6_RE =
  /^([0-9a-fA-F]{2})([:.\- ])([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})\2([0-9a-fA-F]{2})$/;
const MAC_CISCO_3_RE = /^([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})\.([0-9a-fA-F]{4})$/;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates and normalizes a Stalker/Ministra portal MAC address (`#29`).
 * Accepts 6 hex octets separated uniformly by `:`, `-`, `.`, or space, Cisco `XXXX.XXXX.XXXX`
 * groups, or bare 12-hex strings, and returns uppercase `AA:BB:CC:DD:EE:FF`.
 */
export function normalizeMacAddress(raw: unknown): Result<string> {
  if (typeof raw !== 'string') {
    return err(elvError('source-format', 'invalid-mac'));
  }
  // Strip outer spaces/tabs without hiding embedded CR/LF/NUL control characters.
  const stripped = raw.replace(/^[ \t]+|[ \t]+$/g, '');
  if (stripped.length === 0 || hasControlChar(stripped)) {
    return err(elvError('source-format', 'invalid-mac'));
  }
  let hex12: string | undefined;
  if (MAC_BARE_12_RE.test(stripped)) {
    hex12 = stripped;
  } else {
    const pairMatch = MAC_PAIR_6_RE.exec(stripped);
    if (pairMatch !== null) {
      hex12 = `${pairMatch[1]}${pairMatch[3]}${pairMatch[4]}${pairMatch[5]}${pairMatch[6]}${pairMatch[7]}`;
    } else {
      const ciscoMatch = MAC_CISCO_3_RE.exec(stripped);
      if (ciscoMatch !== null) {
        hex12 = `${ciscoMatch[1]}${ciscoMatch[2]}${ciscoMatch[3]}`;
      }
    }
  }
  if (hex12 === undefined) {
    return err(elvError('source-format', 'invalid-mac'));
  }
  const upper = hex12.toUpperCase();
  return ok(
    `${upper.slice(0, 2)}:${upper.slice(2, 4)}:${upper.slice(4, 6)}:${upper.slice(6, 8)}:${upper.slice(8, 10)}:${upper.slice(10, 12)}`,
  );
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
  /** Optional separate User-Agent applied strictly to stream playback and offline downloads. */
  readonly streamUserAgent?: string;
  referer?: string;
  xtreamFormat?: 'ts' | 'm3u8';
  /** Opt-in support for legacy TLS (TLS 1.0/1.1 or older ciphers) for this source only (`#182`). */
  readonly allowLegacyTls?: boolean;
  /** Optional per-source DNS IP family preference (`#172`). */
  readonly dnsFamily?: DnsFamilyPreference;
  /** Optional validated literal IPv4/IPv6 host override scoped strictly to the source origin while keeping TLS SNI (`#172`). */
  readonly hostOverride?: string;
}

/** Request headers (lower-case names) for a source's feed/API transport settings. */
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

/**
 * Request headers (lower-case names) for stream playback and offline downloads: prefers
 * `streamUserAgent` when configured, falling back to feed `userAgent`.
 */
export function streamTransportHeaders(t: TransportSettings | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const rawUa = t?.streamUserAgent !== undefined ? sanitizeHeaderValue(t.streamUserAgent) : '';
  const fallbackUa = t?.userAgent !== undefined ? sanitizeHeaderValue(t.userAgent) : '';
  const effectiveUa = rawUa.length > 0 ? rawUa : fallbackUa;
  if (effectiveUa.length > 0) headers['user-agent'] = effectiveUa;
  if (t?.referer !== undefined) {
    const ref = sanitizeHeaderValue(t.referer);
    if (ref.length > 0) headers.referer = ref;
  }
  return headers;
}

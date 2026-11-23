import { sanitizeHeaderValue } from './headers';

/** Kinds of playlist source a user can add. */
export type SourceKind = 'm3u' | 'xtream';

/** Kinds of playable content. */
export type ContentKind = 'live' | 'movie' | 'series' | 'episode';

/** Per-source transport options. */
export interface TransportSettings {
  userAgent?: string;
  referer?: string;
  xtreamFormat?: 'ts' | 'm3u8';
  /** Opt-in support for legacy TLS (TLS 1.0/1.1 or older ciphers) for this source only (`#182`). */
  readonly allowLegacyTls?: boolean;
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

/** Kinds of playlist source a user can add. */
export type SourceKind = 'm3u' | 'xtream';

/** Kinds of playable content. */
export type ContentKind = 'live' | 'movie' | 'series' | 'episode';

/** Per-source transport options. */
export interface TransportSettings {
  userAgent?: string;
  referer?: string;
  xtreamFormat?: 'ts' | 'm3u8';
}

/** Request headers (lower-case names) for a source's transport settings. */
export function transportHeaders(t: TransportSettings | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (t?.userAgent !== undefined) headers['user-agent'] = t.userAgent;
  if (t?.referer !== undefined) headers.referer = t.referer;
  return headers;
}

import type { TvHomeProgramKind } from './tv-home-channels';

/** Parsed `elviptv://play?key=...` deep-link target (`#273`). */
export interface PlayDeepLinkTarget {
  readonly itemKey: string;
  readonly kind?: TvHomeProgramKind;
}

const VALID_KINDS = new Set<string>(['live', 'movie', 'episode']);
const MAX_ITEM_KEY_CHARS = 512;

/**
 * Parses an incoming `elviptv://play?key=<itemKey>[&kind=live|movie|episode]` deep link (`#273`).
 * Returns `null` for non-matching schemes/routes, control characters, or empty/oversized keys.
 * Stream URLs and credentials are never accepted or embedded in deep links.
 */
export function parsePlayDeepLink(rawUrl: string | null | undefined): PlayDeepLinkTarget | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    return null;
  }
  const trimmed = rawUrl.trim();
  const match = /^elviptv:\/\/play(?:\?(.*))?$/i.exec(trimmed);
  if (match === null) return null;
  const query = match[1] ?? '';
  if (query.length === 0) return null;

  let itemKey: string | undefined;
  let kind: TvHomeProgramKind | undefined;

  for (const part of query.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const rawName = eq >= 0 ? part.slice(0, eq) : part;
    const rawValue = eq >= 0 ? part.slice(eq + 1) : '';
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    if (name === 'key') {
      itemKey = value;
    } else if (name === 'kind' && VALID_KINDS.has(value)) {
      kind = value as TvHomeProgramKind;
    }
  }

  if (itemKey === undefined) return null;
  const cleanKey = itemKey.trim();
  if (cleanKey.length === 0 || cleanKey.length > MAX_ITEM_KEY_CHARS) return null;
  for (let i = 0; i < cleanKey.length; i++) {
    const code = cleanKey.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return kind !== undefined ? { itemKey: cleanKey, kind } : { itemKey: cleanKey };
}

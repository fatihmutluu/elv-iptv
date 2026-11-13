import type { ContentKind } from './source';

const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' };
const KIND_PATH = /^\/(live|movie|series)\/[^/]+\/[^/]+\/(\d+(?:\.[a-z0-9]+)?)$/i;
const TIMESHIFT_PATH = /^\/timeshift\/[^/]+\/[^/]+\/(.+)$/i;
const BARE_PATH = /^\/[^/]+\/[^/]+\/(\d+(?:\.[a-z0-9]+)?)$/i;
/** Lower-case query parameter names treated as credentials or tokens (ADR 0011); dropped from content keys. */
export const CREDENTIAL_PARAMS: ReadonlySet<string> = new Set([
  'username',
  'password',
  'user',
  'pass',
  'pwd',
  'token',
  'auth',
  'key',
  'signature',
  'sig',
  'expires',
  'e',
  'st',
  'hash',
]);

function nameOf(pair: string): string {
  const eq = pair.indexOf('=');
  return eq < 0 ? pair : pair.slice(0, eq);
}

function keptQuery(rest: string): string {
  const q = rest.indexOf('?');
  if (q < 0) return '';
  const hash = rest.indexOf('#', q);
  const raw = rest.slice(q + 1, hash < 0 ? undefined : hash);
  const kept = raw
    .split('&')
    .filter((pair) => pair !== '' && !CREDENTIAL_PARAMS.has(nameOf(pair).toLowerCase()));
  kept.sort((a, b) => {
    const an = nameOf(a);
    const bn = nameOf(b);
    if (an !== bn) return an < bn ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/**
 * Reduces a stream URL to a credential-free identity: lower-case scheme and host, no userinfo, default
 * port removed, no fragment. Query parameters named like credentials or tokens (`username`, `password`,
 * `token`, `sig`, `expires`, ...) are dropped and the rest are kept sorted by name, so `?channel=7` and
 * `?channel=8` stay distinct. Xtream path credentials become `*` only in `/live|movie|series/<u>/<p>/<id>`
 * (numeric id, optional extension), `/timeshift/<u>/<p>/...` and the bare three-segment `/<u>/<p>/<id>`
 * form with a numeric id. An unparsable value is returned trimmed, without anything that looks like
 * userinfo (everything up to the last `@` before a query).
 */
export function normalizeStreamUrl(url: string): string {
  const trimmed = url.trim();
  const m = URL_PARTS.exec(trimmed);
  if (m === null) return trimmed.replace(/^[^?#]*@/, '');
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  const colon = hostPort.lastIndexOf(':');
  const hasPort = colon >= 0 && colon > hostPort.lastIndexOf(']');
  const host = hasPort ? hostPort.slice(0, colon) : hostPort;
  const port = hasPort ? hostPort.slice(colon + 1) : '';
  const keepPort = port !== '' && port !== DEFAULT_PORTS[scheme];
  let path = m[3] || '/';
  const kinded = KIND_PATH.exec(path);
  const shifted = TIMESHIFT_PATH.exec(path);
  const bare = BARE_PATH.exec(path);
  if (kinded) path = `/${(kinded[1] as string).toLowerCase()}/*/*/${kinded[2]}`;
  else if (shifted) path = `/timeshift/*/*/${shifted[1]}`;
  else if (bare) path = `/*/*/${bare[1]}`;
  const query = keptQuery(trimmed.slice(m[0].length));
  return `${scheme}://${host}${keepPort ? `:${port}` : ''}${path}${query}`;
}

/** Stable catalog key for an Xtream item; numeric and string ids are equal. */
export function xtreamKey(
  sourceId: string,
  kind: ContentKind,
  providerId: string | number,
): string {
  return `x:${sourceId}:${kind}:${providerId}`;
}

/** Stable catalog key for an M3U entry; unaffected by credentials or token parameters in the URL. */
export function m3uKey(sourceId: string, url: string, name: string): string {
  return `m:${sourceId}:${normalizeStreamUrl(url)}|${name}`;
}

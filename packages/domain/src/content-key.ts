import type { ContentKind } from './source';

const URL_PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' };
const KIND_PATH = /^\/(live|movie|series|timeshift)\/[^/]+\/[^/]+\/(.+)$/;
const BARE_PATH = /^\/[^/]+\/[^/]+\/(\d+(?:\.[a-z0-9]+)?)$/i;

/**
 * Reduces a stream URL to a credential-free identity: lower-case scheme and host, no userinfo,
 * default port, query or fragment, and Xtream-style path credentials replaced by `*`.
 * An unparsable value is returned trimmed.
 */
export function normalizeStreamUrl(url: string): string {
  const trimmed = url.trim();
  const m = URL_PARTS.exec(trimmed);
  if (m === null) return trimmed;
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
  const bare = BARE_PATH.exec(path);
  if (kinded) path = `/${kinded[1]}/*/*/${kinded[2]}`;
  else if (bare) path = `/*/*/${bare[1]}`;
  return `${scheme}://${host}${keepPort ? `:${port}` : ''}${path}`;
}

/** Stable catalog key for an Xtream item; numeric and string ids are equal. */
export function xtreamKey(
  sourceId: string,
  kind: ContentKind,
  providerId: string | number,
): string {
  return `x:${sourceId}:${kind}:${providerId}`;
}

/** Stable catalog key for an M3U entry; unaffected by credentials or query changes in the URL. */
export function m3uKey(sourceId: string, url: string, name: string): string {
  return `m:${sourceId}:${normalizeStreamUrl(url)}|${name}`;
}

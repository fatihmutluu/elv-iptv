import { sanitizeHeaderName, sanitizeHeaderValue } from '@elv/domain';
import type { KindHint, M3uEntry } from './m3u-types';

const VOD_EXTENSIONS = new Set([
  'mkv',
  'mp4',
  'avi',
  'mov',
  'm4v',
  'webm',
  'flv',
  'wmv',
  'mpg',
  'mpeg',
]);
const LIVE_EXTENSIONS = new Set(['ts', 'm3u8']);
const LAUNCHER_PREFIX_RE = /^(?:ffmpeg|ffrt\d*|auto|solution)\s+/i;
const BACKUP_URL_SPLIT_RE = /#(?=(?:https?|rtmps?|rtsps?|udp|rtp):\/\/)/i;
const MULTICAST_AT_RE = /^(udp|rtp):\/\/@(?=[^:/?#\s])/i;
const EPISODIC_RE = /\b(?:s\d{1,2}\s*e\d{1,3}|\d{1,2}x\d{2})\b/i;
const STREAM_HEADERS_PROPS = new Set([
  'inputstream.adaptive.stream_headers',
  'inputstream.ffmpegdirect.stream_headers',
]);

function schemeEnd(url: string): number {
  const n = url.length;
  for (let i = 0; i < n; i++) {
    const c = url.charCodeAt(i);
    if (c === 58) return i >= 2 ? i : -1;
    const alpha = (c | 32) >= 97 && (c | 32) <= 122;
    const rest = (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
    if (!(alpha || (i > 0 && rest))) return -1;
  }
  return -1;
}

function stripUrlLauncherPrefix(raw: string): string {
  const match = LAUNCHER_PREFIX_RE.exec(raw);
  return match === null ? raw : raw.slice(match[0].length).trimStart();
}

function splitPipeUrl(raw: string): { url: string; pipeHeaders?: string } {
  const pipeIdx = raw.indexOf('|');
  if (pipeIdx < 0) return { url: raw };
  return {
    url: raw.slice(0, pipeIdx).trimEnd(),
    pipeHeaders: raw.slice(pipeIdx + 1),
  };
}

function normalizeMulticastUrl(url: string): string {
  return url.replace(MULTICAST_AT_RE, '$1://');
}

function splitBackupUrls(raw: string): { primary: string; backups: string[] } {
  const parts = raw.split(BACKUP_URL_SPLIT_RE);
  const primary = (parts[0] ?? raw).trimEnd();
  if (parts.length <= 1) return { primary, backups: [] };
  const backups: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const segment = stripUrlLauncherPrefix((parts[i] ?? '').trim());
    const cleaned = normalizeMulticastUrl(splitPipeUrl(segment).url.trim());
    if (cleaned.length > 0) backups.push(cleaned);
  }
  return { primary, backups };
}

function safeDecodeComponent(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function applySanitizedHeader(e: M3uEntry, rawKey: string, rawValue: string): void {
  const name = sanitizeHeaderName(rawKey.toLowerCase());
  if (name === undefined) return;
  const value = sanitizeHeaderValue(rawValue);
  if (value.length === 0) return;
  if (name === 'user-agent') e.headers.userAgent = value;
  else if (name === 'referer' || name === 'referrer') e.headers.referer = value;
  else e.headers.other[name] = value;
}

function applyStreamHeaderPairs(e: M3uEntry, rawPairs: string): void {
  for (const part of rawPairs.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = safeDecodeComponent(part.slice(0, eq));
    const value = safeDecodeComponent(part.slice(eq + 1));
    applySanitizedHeader(e, key, value);
  }
}

/**
 * True when a non-comment playlist line can be an entry URL: it has a scheme (`xx://`) or, when `baseUrl`
 * is set, it is a relative reference without whitespace, `<`, `{`, `"`, `'`, `;`, `)` or `>`.
 */
export function looksLikeUrl(raw: string, baseUrl: string | undefined): boolean {
  const { primary } = splitBackupUrls(raw);
  const stripped = stripUrlLauncherPrefix(primary);
  const { url } = splitPipeUrl(stripped);
  if (url.length === 0) return false;
  const end = schemeEnd(url);
  if (end >= 0 && url.startsWith('://', end)) return true;
  return baseUrl !== undefined && baseUrl !== '' && !/[\s<{"');>]/.test(url);
}

function resolve(url: string, base: string): string {
  const baseEnd = schemeEnd(base);
  if (baseEnd < 0 || base.slice(baseEnd, baseEnd + 3) !== '://') return url;
  const scheme = base.slice(0, baseEnd);
  if (url.startsWith('//')) return `${scheme}:${url}`;
  const hostStart = baseEnd + 3;
  let hostEnd = base.length;
  for (let i = hostStart; i < base.length; i++) {
    const c = base.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) {
      hostEnd = i;
      break;
    }
  }
  const origin = base.slice(0, hostEnd);
  if (url.startsWith('/')) return origin + url;
  const rest = base.slice(hostEnd);
  const pathEnd = rest.search(/[?#]/);
  const path = pathEnd < 0 ? rest : rest.slice(0, pathEnd);
  return `${origin}${path.slice(0, path.lastIndexOf('/') + 1) || '/'}${url}`;
}

function kindOf(url: string, schemeLen: number, entryName: string): KindHint {
  const pathStart = url.indexOf('/', schemeLen + 3);
  if (pathStart < 0) return 'live';
  let pathEnd = url.length;
  let queryStart = -1;
  for (let i = pathStart; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 63) {
      pathEnd = i;
      queryStart = i;
      break;
    }
    if (c === 35) {
      pathEnd = i;
      break;
    }
  }
  const path = url.slice(pathStart, pathEnd).toLowerCase();
  const isEpisodic = EPISODIC_RE.test(entryName) || EPISODIC_RE.test(path);

  if (path.includes('/series/') || path.includes('/episodes/') || path.includes('/episode/')) {
    return 'episode';
  }
  if (path.includes('/live/')) return 'live';
  if (
    path.includes('/movie/') ||
    path.includes('/movies/') ||
    path.includes('/vod/') ||
    path.includes('/film/') ||
    path.includes('/films/')
  ) {
    return isEpisodic ? 'episode' : 'movie';
  }
  if (queryStart >= 0) {
    const query = url.slice(queryStart).toLowerCase();
    if (/(?:^\?|&)channel=/.test(query)) return 'live';
  }
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1) : '';
  if (LIVE_EXTENSIONS.has(ext)) return 'live';
  if (VOD_EXTENSIONS.has(ext)) return isEpisodic ? 'episode' : 'movie';
  if (isEpisodic) return 'episode';
  return 'live';
}

/** Sets the entry's URL (splitting inline backups, parsing pipe headers, and resolving relative URLs), `kindHint` and `nonHttp`. */
export function finishEntry(e: M3uEntry, rawUrl: string, baseUrl: string | undefined): void {
  const { primary, backups } = splitBackupUrls(rawUrl);
  const stripped = stripUrlLauncherPrefix(primary);
  const { url: cleanRaw, pipeHeaders } = splitPipeUrl(stripped);
  if (pipeHeaders !== undefined) applyStreamHeaderPairs(e, pipeHeaders);

  let url = normalizeMulticastUrl(cleanRaw);
  let end = schemeEnd(url);
  if (end < 0 && baseUrl) {
    url = resolve(url, baseUrl);
    end = schemeEnd(url);
  }
  e.url = url;
  if (backups.length > 0) e.backupUrls = backups;
  if (end < 0) return;
  const scheme = url.slice(0, end).toLowerCase();
  e.nonHttp = scheme !== 'http' && scheme !== 'https';
  e.kindHint = e.nonHttp ? 'live' : kindOf(url, end, e.name);
}

/** Applies one `#EXTVLCOPT:` or `#EXTVLCOPT--` payload (`key=value`) to the entry. */
export function applyVlcOpt(e: M3uEntry, payload: string): void {
  const trimmed = payload.trim().replace(/^--+/, '');
  const eq = trimmed.indexOf('=');
  if (eq < 0) {
    if (trimmed.toLowerCase() === 'http-reconnect') e.extra['http-reconnect'] = 'true';
    return;
  }
  const key = trimmed.slice(0, eq).trim().toLowerCase();
  const rawValue = trimmed.slice(eq + 1);
  if (key === 'http-user-agent') applySanitizedHeader(e, 'user-agent', rawValue);
  else if (key === 'http-referrer' || key === 'http-referer') {
    applySanitizedHeader(e, 'referer', rawValue);
  } else if (key === 'http-reconnect') {
    const clean = sanitizeHeaderValue(rawValue);
    if (clean.length > 0) e.extra['http-reconnect'] = clean;
  }
}

/** Applies one `#EXTHTTP:` JSON payload; returns false when it is not a JSON object. */
export function applyExtHttp(e: M3uEntry, payload: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  for (const [rawKey, raw] of Object.entries(parsed)) {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue;
    applySanitizedHeader(e, rawKey, String(raw));
  }
  return true;
}

/** Applies one `#KODIPROP:` payload (`key=value`) and extracts adaptive `stream_headers` (`#270`). */
export function applyKodiProp(e: M3uEntry, payload: string): void {
  const eq = payload.indexOf('=');
  if (eq <= 0) return;
  const key = payload.slice(0, eq).trim();
  const value = payload.slice(eq + 1).trim();
  e.kodiProps[key] = value;
  if (STREAM_HEADERS_PROPS.has(key.toLowerCase()) && value.length > 0) {
    applyStreamHeaderPairs(e, value);
  }
}

/** Splits comma-, semicolon-, whitespace-, or `.xml`/`gz` (`/`-optional) concatenated `url-tvg` / `x-tvg-url` attributes (`#173`). */
export function splitGuideUrls(value: string): string[] {
  return value
    .replace(/(\.(?:xml|gz))\/?(?=https?:\/\/)/gi, '$1 ')
    .split(/[\s,;]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

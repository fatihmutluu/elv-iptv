import { CREDENTIAL_PARAMS } from './content-key';

const URL_PATTERN =
  /\b(?:(?:https?|rtsps?|rtmps?|tcp|tls|httpproxy|udp|rtp|ftp):\/\/|file:(?:\/\/|\/))[^\s'"<>]+/gi;
const FILE_SCHEME_RE = /^file:/i;
const TRAILING_PUNCT = /[.,;:)\]]+$/;
const USERINFO_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\\]*@/;

const SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.m2ts',
  '.mts',
  '.m3u8',
  '.m3u',
  '.mp4',
  '.m4s',
  '.m4v',
  '.m4a',
  '.mkv',
  '.webm',
  '.avi',
  '.mov',
  '.flv',
  '.mpd',
  '.aac',
  '.mp3',
  '.ac3',
  '.eac3',
  '.ogg',
  '.opus',
  '.wav',
  '.flac',
  '.srt',
  '.vtt',
  '.ass',
  '.ssa',
  '.sub',
  '.xml',
  '.gz',
  '.php',
]);

const EXTRA_SECRET_PARAMS = [
  'passwd',
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'wmsAuthSign',
  'session',
  'jwt',
];

const SECRET_PARAM_NAMES = [...new Set([...CREDENTIAL_PARAMS, ...EXTRA_SECRET_PARAMS])].sort(
  (a, b) => b.length - a.length,
);

const SECRET_HEADERS =
  /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)\s*:\s*[^\r\n]*/gi;
const BEARER_TOKENS = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PARAMS = new RegExp(
  `\\b(${SECRET_PARAM_NAMES.join('|')})\\s*=\\s*[^&\\s'";,)]*`,
  'gi',
);
const WIN_HOME_PATH_RE = /\b[a-zA-Z]:[\\/]+Users[\\/]+[^\s'"<>)\]]+/gi;
const UNIX_HOME_PATH_RE = /(^|[^\w:/\\])(\/(?:Users|home)\/[^\s'"<>)\]]+)/g;
const ANDROID_USER_PATH_RE = /(^|[^\w:/\\])(\/data\/user\/\d+(?:\/[^\s'"<>)\]]*)?)/g;

function maskHomePath(rawMatch: string): string {
  const punctMatch = TRAILING_PUNCT.exec(rawMatch);
  const trailing = punctMatch ? punctMatch[0] : '';
  return `<redacted-path>${trailing}`;
}

function redactHomePaths(text: string): string {
  return text
    .replace(WIN_HOME_PATH_RE, maskHomePath)
    .replace(
      UNIX_HOME_PATH_RE,
      (_m, prefix: string, path: string) => `${prefix}${maskHomePath(path)}`,
    )
    .replace(
      ANDROID_USER_PATH_RE,
      (_m, prefix: string, path: string) => `${prefix}${maskHomePath(path)}`,
    );
}

function maskSegment(segment: string, isLastNonEmpty: boolean): string {
  if (segment === '') return '';
  if (!isLastNonEmpty) return '***';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return '***';
  const ext = segment.slice(dot);
  return SAFE_EXTENSIONS.has(ext.toLowerCase()) ? `***${ext}` : '***';
}

function maskPath(path: string): string {
  if (path === '/') return '/';
  const rawSegments = path.slice(1).split('/');
  let lastNonEmpty = -1;
  for (let i = rawSegments.length - 1; i >= 0; i -= 1) {
    if (rawSegments[i] !== '') {
      lastNonEmpty = i;
      break;
    }
  }
  const masked = rawSegments.map((seg, idx) => maskSegment(seg, idx === lastNonEmpty));
  return `/${masked.join('/')}`;
}

/**
 * Strict allowlist URL redaction: strips userinfo, Xtream/tokenized path segments, query strings,
 * and fragments while keeping only the scheme, host(:port), and a known media/playlist extension on
 * the final path segment. `file:` URLs are collapsed completely to `file://<redacted>`.
 */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (FILE_SCHEME_RE.test(trimmed)) return 'file://<redacted>';
  const schemeSep = trimmed.indexOf('://');
  if (schemeSep < 0) {
    if (trimmed.startsWith('/')) {
      return maskPath(trimmed.replace(/[?#].*$/s, ''));
    }
    return redactSecretsOnly(trimmed);
  }
  const withoutTail = trimmed.replace(/[?#].*$/s, '');
  const withoutUser = withoutTail.replace(USERINFO_RE, '$1');
  const schemeEnd = withoutUser.indexOf('//') + 2;
  const relPathStart = withoutUser.slice(schemeEnd).search(/[/\\]/);
  if (relPathStart === -1) return withoutUser;
  const pathStart = schemeEnd + relPathStart;
  const origin = withoutUser.slice(0, pathStart);
  const normalizedPath = withoutUser.slice(pathStart).replace(/\\/g, '/');
  return `${origin}${maskPath(normalizedPath)}`;
}

function redactOneUrl(rawMatch: string): string {
  const punctMatch = TRAILING_PUNCT.exec(rawMatch);
  const trailing = punctMatch ? punctMatch[0] : '';
  const url = trailing.length > 0 ? rawMatch.slice(0, -trailing.length) : rawMatch;
  return `${redactUrl(url)}${trailing}`;
}

function redactSecretsOnly(text: string): string {
  return text
    .replace(SECRET_HEADERS, '$1: ***')
    .replace(BEARER_TOKENS, '$1 ***')
    .replace(SECRET_PARAMS, '$1=***');
}

/**
 * Redacts all URLs (`http(s)`, `rtsp(s)`, `rtmp(s)`, `tcp`, `tls`, `httpproxy`, `udp`, `rtp`,
 * `ftp`, `file`), OS home directory paths (`C:\Users\...`, `/Users/...`, `/home/...`,
 * `/data/user/<n>/...`), sensitive HTTP header lines (`Authorization`, `Proxy-Authorization`,
 * `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`), `Bearer`/`Basic` tokens, and sensitive
 * query parameter assignments (`CREDENTIAL_PARAMS` and common token keys) from arbitrary log/error text.
 */
export function redactText(text: string): string {
  return redactSecretsOnly(redactHomePaths(text.replace(URL_PATTERN, redactOneUrl)));
}

const URL_PATTERN = /\b(?:https?|rtsps?|rtmps?|tcp|tls|httpproxy):\/\/[^\s'"<>]+/gi;
const TRAILING_PUNCT = /[.,;:)\]]+$/;

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

const SECRET_HEADERS = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi;
const BEARER_TOKENS = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_PARAMS =
  /\b(username|user|password|pass|passwd|pwd|token|access_token|auth|auth_token|api_key|apikey|key|sig|signature|wmsAuthSign|session|jwt)\s*=\s*[^&\s'";,)]*/gi;

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

function redactOneUrl(rawMatch: string): string {
  const punctMatch = TRAILING_PUNCT.exec(rawMatch);
  const trailing = punctMatch ? punctMatch[0] : '';
  const url = trailing.length > 0 ? rawMatch.slice(0, -trailing.length) : rawMatch;
  const withoutTail = url.replace(/[?#].*$/s, '');
  const withoutUser = withoutTail.replace(/^([a-zA-Z]+:\/\/)[^/@]*@/, '$1');
  const schemeEnd = withoutUser.indexOf('//') + 2;
  const pathStart = withoutUser.indexOf('/', schemeEnd);
  if (pathStart === -1) return `${withoutUser}${trailing}`;
  const origin = withoutUser.slice(0, pathStart);
  return `${origin}${maskPath(withoutUser.slice(pathStart))}${trailing}`;
}

/**
 * Strict allowlist URL and credential redaction: keeps only a URL's scheme, host(:port) and a known
 * media/playlist extension on the final segment, masking all path segments, user-info, queries and
 * fragments across `http(s)`, `tcp`, `tls`, `rtsp(s)`, `rtmp(s)` and `httpproxy`, plus stray
 * `Authorization:`, `Cookie:`, `Bearer` and `token=`/`auth=`/`username=`/`password=` secrets.
 */
export function redactUrls(text: string): string {
  return text
    .replace(URL_PATTERN, redactOneUrl)
    .replace(SECRET_HEADERS, '$1: ***')
    .replace(BEARER_TOKENS, '$1 ***')
    .replace(SECRET_PARAMS, '$1=***');
}

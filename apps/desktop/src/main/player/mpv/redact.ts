const URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;
const XTREAM_PREFIX = /^(live|movie|series|timeshift)$/;
const CREDENTIAL_PARAM = /\b(username|password)=[^&\s]*/gi;

function maskPath(path: string): string {
  const segments = path.split('/').slice(1);
  if (segments.length >= 4 && XTREAM_PREFIX.test(segments[0] ?? '')) {
    segments[1] = '***';
    segments[2] = '***';
  } else if (segments.length === 3 && segments[2] !== '') {
    segments[0] = '***';
    segments[1] = '***';
  }
  return `/${segments.join('/')}`;
}

/**
 * Removes secrets from any URL inside `text`: user-info, query and fragment are dropped and the
 * Xtream username and password path segments (`/live|movie|series|timeshift/<user>/<pass>/<id>` and
 * the short `/<user>/<pass>/<id>` form) become `***`. Stray `username=` and `password=` pairs
 * outside a URL are masked too.
 */
export function redactUrls(text: string): string {
  return text
    .replace(URL_PATTERN, (url) => {
      const withoutTail = url.replace(/[?#].*$/s, '');
      const withoutUser = withoutTail.replace(/^(https?:\/\/)[^/@]*@/, '$1');
      const pathStart = withoutUser.indexOf('/', withoutUser.indexOf('//') + 2);
      if (pathStart === -1) return withoutUser;
      return withoutUser.slice(0, pathStart) + maskPath(withoutUser.slice(pathStart));
    })
    .replace(CREDENTIAL_PARAM, '$1=***');
}

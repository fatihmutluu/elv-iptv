/**
 * Validates `ELV_DEV_SERVER_URL` for unpackaged development and returns its canonical
 * `http://<host>:<port>` origin (without trailing slash), or `null` when packaged or invalid.
 */
export function parseDevServerUrl(
  raw: string | undefined,
  opts: { isPackaged: boolean },
): string | null {
  if (opts.isPackaged) return null;
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:' ||
    (hostname !== '127.0.0.1' && hostname !== 'localhost') ||
    !/^[1-9]\d{0,4}$/.test(url.port) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?$/i.test(trimmed)
  ) {
    return null;
  }
  return `http://${hostname}:${url.port}`;
}

/**
 * Returns `true` when `requestUrl` is a clean `http:` URL without credentials whose origin
 * matches `allowedOrigin` (case-insensitive).
 */
export function isAllowedDevNavigation(requestUrl: string, allowedOrigin: string): boolean {
  if (allowedOrigin === '') return false;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    url.origin.toLowerCase() === allowedOrigin.toLowerCase()
  );
}

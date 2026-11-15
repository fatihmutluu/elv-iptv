import { resolve, sep } from 'node:path';

/** Custom scheme that serves the exported renderer. */
export const APP_SCHEME = 'app';
const APP_HOST = 'elv';
/** Origin of the renderer as the window sees it. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Content-Security-Policy for the renderer. `style-src` allows inline styles because
 * react-native-web injects `<style>` tags at runtime; scripts stay restricted to the app origin.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http:",
  "worker-src 'self'",
  "frame-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;
const CANONICAL_APP_URL = /^app:\/\/elv(\/[^?#]*)?(?:[?#]|$)/i;

/**
 * Maps an app URL to a file inside `rootDir`. Returns `null` for other hosts, schemes, ports, or
 * userinfo, malformed URLs, and any path that is absolute, uses colons (drive letters or NTFS
 * alternate data streams), backslashes, or `..` segments (also when percent-encoded), or would
 * resolve outside `rootDir`.
 */
export function resolveAppFile(rootDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname.toLowerCase() !== APP_HOST) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;

  // URL parsing already collapses dot segments, so inspect the raw path as sent.
  const match = CANONICAL_APP_URL.exec(requestUrl);
  if (!match) return null;
  const rawPath = match[1] ?? '';
  let relative: string;
  try {
    relative = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (relative.startsWith('//')) return null;
  relative = relative.replace(/^\//, '');
  if (relative === '') relative = 'index.html';
  if (relative.includes(BACKSLASH) || relative.includes(NUL) || relative.includes(':')) return null;
  if (DOT_SEGMENT.test(relative)) return null;

  const root = resolve(rootDir);
  const file = resolve(root, relative);
  return file.startsWith(root + sep) ? file : null;
}

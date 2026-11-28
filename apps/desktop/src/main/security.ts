import { APP_SCHEME } from './app-protocol.ts';
import { isAllowedDevNavigation } from './dev-server.ts';

const CANONICAL_NAVIGATION = /^app:\/\/elv(?:[/?#]|$)/i;
const CANONICAL_TRAILER_EMBED =
  /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}(?:[?#]|$)/i;
const STRICT_TRAILER_EMBED_PATH = /^\/embed\/[A-Za-z0-9_-]{11}$/;

export interface NavigationEventLike {
  readonly url: string;
  readonly isMainFrame?: boolean;
  preventDefault(): void;
}

export interface WebContentsGuardTarget {
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(
    event: 'will-navigate',
    listener: (details: NavigationEventLike, url: string) => void,
  ): unknown;
  on(
    event: 'will-redirect',
    listener: (details: NavigationEventLike, url: string) => void,
  ): unknown;
  on(event: 'will-frame-navigate', listener: (details: NavigationEventLike) => void): unknown;
}

export interface SessionGuardTarget {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (permissionGranted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string, requestingOrigin: string) => boolean,
  ): void;
}

/** Returns `true` only for canonical `app://elv` URLs without credentials or an explicit port. */
export function isAllowedAppNavigation(requestUrl: string): boolean {
  if (!CANONICAL_NAVIGATION.test(requestUrl)) return false;
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === `${APP_SCHEME}:` &&
    url.hostname.toLowerCase() === 'elv' &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
  );
}

/**
 * Returns `true` strictly for canonical `https://www.youtube-nocookie.com/embed/<11-char-id>`
 * subframe URLs without credentials, custom/explicit ports, or control/whitespace characters,
 * matching `CONTENT_SECURITY_POLICY`'s `frame-src`.
 */
export function isAllowedTrailerEmbedUrl(requestUrl: string): boolean {
  if (typeof requestUrl !== 'string' || !CANONICAL_TRAILER_EMBED.test(requestUrl)) return false;
  for (let i = 0; i < requestUrl.length; i += 1) {
    const code = requestUrl.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname.toLowerCase() === 'www.youtube-nocookie.com' &&
    url.username === '' &&
    url.password === '' &&
    url.port === '' &&
    STRICT_TRAILER_EMBED_PATH.test(url.pathname)
  );
}

/**
 * Blocks new windows and locks top-level navigation and redirects strictly to `app://elv`
 * (or `opts.devOrigin` when unpackaged Metro Fast Refresh is active). Subframes are locked to the
 * same origins plus canonical `https://www.youtube-nocookie.com/embed/<id>` trailer embeds.
 */
export function lockDownWebContents(
  contents: WebContentsGuardTarget,
  opts?: { devOrigin?: string | null },
): void {
  const devOrigin = opts?.devOrigin ?? null;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const isTopLevelAllowed = (target: string): boolean =>
    isAllowedAppNavigation(target) ||
    (devOrigin !== null && devOrigin !== '' && isAllowedDevNavigation(target, devOrigin));

  const topLevelGuard = (details: NavigationEventLike, legacyUrl?: string) => {
    const target = details.url ?? legacyUrl ?? '';
    if (!isTopLevelAllowed(target)) details.preventDefault();
  };

  const frameGuard = (details: NavigationEventLike) => {
    const target = details.url ?? '';
    const allowed =
      isTopLevelAllowed(target) ||
      (details.isMainFrame === false && isAllowedTrailerEmbedUrl(target));
    if (!allowed) details.preventDefault();
  };

  contents.on('will-navigate', topLevelGuard);
  contents.on('will-redirect', topLevelGuard);
  contents.on('will-frame-navigate', frameGuard);
}

/** Denies all Chromium permission checks and permission requests by default (`#17`). */
export function lockDownSession(ses: SessionGuardTarget): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
}

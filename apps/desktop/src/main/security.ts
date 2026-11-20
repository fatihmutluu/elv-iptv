import { APP_SCHEME } from './app-protocol.ts';
import { isAllowedDevNavigation } from './dev-server.ts';

const CANONICAL_NAVIGATION = /^app:\/\/elv(?:[/?#]|$)/i;

export interface NavigationEventLike {
  readonly url: string;
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
 * Blocks new windows and any top-level, redirect, or subframe navigation away from `app://elv`
 * (or `opts.devOrigin` when unpackaged Metro Fast Refresh is active).
 */
export function lockDownWebContents(
  contents: WebContentsGuardTarget,
  opts?: { devOrigin?: string | null },
): void {
  const devOrigin = opts?.devOrigin ?? null;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (details: NavigationEventLike, legacyUrl?: string) => {
    const target = details.url ?? legacyUrl ?? '';
    const allowed =
      isAllowedAppNavigation(target) ||
      (devOrigin !== null && devOrigin !== '' && isAllowedDevNavigation(target, devOrigin));
    if (!allowed) details.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-frame-navigate', guard);
}

/** Denies all Chromium permission checks and permission requests by default (`#17`). */
export function lockDownSession(ses: SessionGuardTarget): void {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
}
